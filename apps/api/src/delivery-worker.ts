import { hostname } from 'node:os';
import process from 'node:process';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { config } from './config.js';
import {
  acknowledgeMachineCommand,
  deliveryBacklog,
  failMachineCommandTerminal,
  markOutboxPublished,
  claimOutboxEvents,
  rescheduleMachineCommandFailure,
  rescheduleOutboxFailure,
  type ClaimedMachineCommand,
  type ClaimedOutboxEvent,
} from './delivery-store.js';
import {
  commandDispatchConfigFromEnv,
  commandGatewayAssigned,
  dispatchToGateway,
  readTerminalGatewayAck,
  type CommandDispatchConfig,
  type TerminalGatewayAck,
} from './control-command-dispatch.js';
import { claimGatewayMachineCommands, gatewayCommandMachineIds } from './gateway-command-store.js';
import { validateDeliveryKey } from './reliable-delivery.js';
import { reconcileDevelopmentBookings } from './dev-booking-reconciler.js';
import { finalizeVerifiedDeveloperStop } from './workspace-stop-finalizer.js';

const POLL_INTERVAL_MS = 250;
const HEALTH_INTERVAL_MS = 15_000;
const RECONCILE_INTERVAL_MS = 1_000;
const SHUTDOWN_GRACE_MS = 20_000;
const MAX_IN_FLIGHT = 32;
const COMMAND_ACK_WAIT_MS = 1_500;
const COMMAND_ACK_POLL_MS = 75;

function workerIdentity(): string {
  const suffix = process.env.DELIVERY_WORKER_ID ?? `${hostname()}_${process.pid}`;
  const normalized = `delivery_${suffix}`.replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 120);
  return validateDeliveryKey(normalized, 'worker_id');
}

function streamName(topic: string): string {
  return `gpubnb:events:${topic}`;
}

function serializeHeaders(event: ClaimedOutboxEvent): string {
  return JSON.stringify(event.headers ?? {});
}

async function publish(redis: Redis, event: ClaimedOutboxEvent): Promise<void> {
  await redis.xadd(
    streamName(event.topic), 'MAXLEN', '~', '1000000', '*',
    'eventId', event.id,
    'eventType', event.eventType,
    'aggregateType', event.aggregateType,
    'aggregateId', event.aggregateId,
    'partitionKey', event.partitionKey,
    'idempotencyKey', event.idempotencyKey,
    'payload', JSON.stringify(event.payload),
    'headers', serializeHeaders(event),
    'createdAt', event.createdAt.toISOString(),
  );
}

async function runBounded<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) await task(item);
    }
  });
  await Promise.all(workers);
}

async function waitForTerminalAck(redis: Redis, command: ClaimedMachineCommand): Promise<TerminalGatewayAck | undefined> {
  const deadline = Date.now() + COMMAND_ACK_WAIT_MS;
  do {
    const ack = await readTerminalGatewayAck(redis, command);
    if (ack) return ack;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, COMMAND_ACK_POLL_MS));
  } while (true);
}

async function finishTerminalCommand(
  db: PrismaClient,
  redis: Redis,
  command: ClaimedMachineCommand,
  workerId: string,
  ack: TerminalGatewayAck,
): Promise<'ACKNOWLEDGED' | 'DEAD' | 'LEASE_LOST'> {
  if (ack.status === 'SUCCEEDED') {
    if (command.commandType === 'stop_rental') {
      const sessionId = command.payload.sessionId;
      if (command.payload.workspaceSlug !== 'developer' || typeof sessionId !== 'string') {
        throw new Error('verified_stop_missing_developer_session_identity');
      }
      // The Host ACK proves the exact Developer resources are gone. Finalize the
      // server-owned session before acknowledging the durable command. If this
      // transaction or Redis cleanup fails, the command lease expires and a later
      // worker retries this idempotent finalization without re-running Docker.
      await finalizeVerifiedDeveloperStop(db, redis, sessionId, command.machineId);
    }
    return await acknowledgeMachineCommand(db, command.id, command.machineId, workerId)
      ? 'ACKNOWLEDGED'
      : 'LEASE_LOST';
  }
  const reason = `${ack.status.toLowerCase()}:${ack.detailCode ?? 'agent_terminal_failure'}`;
  return await failMachineCommandTerminal(db, command.id, command.machineId, workerId, reason)
    ? 'DEAD'
    : 'LEASE_LOST';
}

async function main(): Promise<void> {
  const db = new PrismaClient();
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  const workerId = workerIdentity();
  const dispatchConfig: CommandDispatchConfig = commandDispatchConfigFromEnv();
  let stopping = false;
  let inFlight = 0;
  let published = 0;
  let failed = 0;
  let leaseLost = 0;
  let commandDispatched = 0;
  let commandAcknowledged = 0;
  let commandTerminalFailed = 0;
  let lastHealthAt = 0;
  let lastReconcileAt = 0;

  const stop = (): void => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    await redis.connect();
    await db.$connect();
    console.info(JSON.stringify({
      level: 'info',
      message: 'delivery_worker_started',
      workerId,
      machineCommandGatewayRolloutBps: dispatchConfig.rolloutBps,
    }));

    while (!stopping) {
      const now = Date.now();
      if (now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
        try {
          const reconciliation = await reconcileDevelopmentBookings(db, new Date(now));
          if (Object.values(reconciliation).some((value) => value > 0)) {
            console.info(JSON.stringify({ level: 'info', message: 'gpu_booking_reconciled', ...reconciliation }));
          }
        } catch (error) {
          failed += 1;
          console.error(JSON.stringify({
            level: 'error',
            message: 'gpu_booking_reconcile_failed',
            error: error instanceof Error ? error.message.slice(0, 300) : 'unknown_error',
          }));
        }
        lastReconcileAt = now;
      }

      let claimedCommands = 0;
      if (dispatchConfig.rolloutBps > 0) {
        const machineIds = await gatewayCommandMachineIds(db, 100);
        for (const machineId of machineIds) {
          if (!commandGatewayAssigned(machineId, dispatchConfig)) continue;
          const commands = await claimGatewayMachineCommands(db, machineId, workerId, 16, 15);
          claimedCommands += commands.length;
          inFlight += commands.length;
          await runBounded(commands, Math.min(MAX_IN_FLIGHT, 8), async (command) => {
            try {
              const existingAck = await readTerminalGatewayAck(redis, command);
              if (existingAck) {
                const outcome = await finishTerminalCommand(db, redis, command, workerId, existingAck);
                if (outcome === 'ACKNOWLEDGED') commandAcknowledged += 1;
                else if (outcome === 'DEAD') commandTerminalFailed += 1;
                else leaseLost += 1;
                return;
              }

              const dispatchStatus = await dispatchToGateway(command, dispatchConfig);
              commandDispatched += 1;
              if (dispatchStatus === 'DELIVERED' || dispatchStatus === 'EXISTING') {
                const terminalAck = await waitForTerminalAck(redis, command);
                if (terminalAck) {
                  const outcome = await finishTerminalCommand(db, redis, command, workerId, terminalAck);
                  if (outcome === 'ACKNOWLEDGED') commandAcknowledged += 1;
                  else if (outcome === 'DEAD') commandTerminalFailed += 1;
                  else leaseLost += 1;
                }
              }
              // If no terminal ACK is visible yet, deliberately keep the short DB
              // lease. On expiry another worker checks Redis before redispatching.
            } catch (error) {
              failed += 1;
              const outcome = await rescheduleMachineCommandFailure(db, command, workerId, error);
              if (outcome === 'LEASE_LOST') leaseLost += 1;
              console.error(JSON.stringify({
                level: 'error', message: 'machine_command_gateway_failed', workerId,
                commandId: command.id, machineId: command.machineId, commandType: command.commandType,
                attempts: command.attempts, outcome,
                error: error instanceof Error ? error.message.slice(0, 300) : 'unknown_error',
              }));
            } finally {
              inFlight = Math.max(0, inFlight - 1);
            }
          });
        }
      }

      const events = await claimOutboxEvents(db, workerId, 500, 45);
      inFlight += events.length;
      if (events.length > 0) {
        await runBounded(events, MAX_IN_FLIGHT, async (event) => {
          try {
            await publish(redis, event);
            const acknowledged = await markOutboxPublished(db, event.id, workerId);
            if (acknowledged) published += 1;
            else leaseLost += 1;
          } catch (error) {
            failed += 1;
            const outcome = await rescheduleOutboxFailure(db, event, workerId, error);
            if (outcome === 'LEASE_LOST') leaseLost += 1;
            console.error(JSON.stringify({
              level: 'error', message: 'outbox_publish_failed', workerId, eventId: event.id,
              attempts: event.attempts, outcome,
              error: error instanceof Error ? error.message.slice(0, 300) : 'unknown_error',
            }));
          } finally {
            inFlight = Math.max(0, inFlight - 1);
          }
        });
      }

      if (events.length === 0 && claimedCommands === 0) {
        if (now - lastHealthAt >= HEALTH_INTERVAL_MS) {
          const backlog = await deliveryBacklog(db);
          console.info(JSON.stringify({
            level: 'info', message: 'delivery_worker_health', workerId,
            published, failed, leaseLost, commandDispatched, commandAcknowledged, commandTerminalFailed,
            machineCommandGatewayRolloutBps: dispatchConfig.rolloutBps,
            backlog: Object.fromEntries(Object.entries(backlog).map(([key, value]) => [key, value.toString()])),
          }));
          lastHealthAt = now;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
  } finally {
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await Promise.allSettled([redis.quit(), db.$disconnect()]);
    console.info(JSON.stringify({
      level: 'info', message: 'delivery_worker_stopped', workerId,
      published, failed, leaseLost, commandDispatched, commandAcknowledged, commandTerminalFailed,
    }));
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({
      level: 'fatal', message: 'delivery_worker_crashed',
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
