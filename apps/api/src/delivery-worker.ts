import { hostname } from 'node:os';
import process from 'node:process';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { config } from './config.js';
import {
  claimOutboxEvents,
  deliveryBacklog,
  markOutboxPublished,
  rescheduleOutboxFailure,
  type ClaimedOutboxEvent,
} from './delivery-store.js';
import { validateDeliveryKey } from './reliable-delivery.js';

const POLL_INTERVAL_MS = 250;
const HEALTH_INTERVAL_MS = 15_000;
const SHUTDOWN_GRACE_MS = 20_000;
const MAX_IN_FLIGHT = 32;

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
    streamName(event.topic),
    'MAXLEN',
    '~',
    '1000000',
    '*',
    'eventId',
    event.id,
    'eventType',
    event.eventType,
    'aggregateType',
    event.aggregateType,
    'aggregateId',
    event.aggregateId,
    'partitionKey',
    event.partitionKey,
    'idempotencyKey',
    event.idempotencyKey,
    'payload',
    JSON.stringify(event.payload),
    'headers',
    serializeHeaders(event),
    'createdAt',
    event.createdAt.toISOString(),
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

async function main(): Promise<void> {
  const db = new PrismaClient();
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  const workerId = workerIdentity();
  let stopping = false;
  let inFlight = 0;
  let published = 0;
  let failed = 0;
  let leaseLost = 0;
  let lastHealthAt = 0;

  const stop = (): void => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    await redis.connect();
    await db.$connect();
    console.info(JSON.stringify({ level: 'info', message: 'delivery_worker_started', workerId }));

    while (!stopping) {
      const events = await claimOutboxEvents(db, workerId, 100, 45);
      inFlight = events.length;
      if (events.length === 0) {
        const now = Date.now();
        if (now - lastHealthAt >= HEALTH_INTERVAL_MS) {
          const backlog = await deliveryBacklog(db);
          console.info(JSON.stringify({
            level: 'info',
            message: 'delivery_worker_health',
            workerId,
            published,
            failed,
            leaseLost,
            backlog: {
              ...backlog,
              pendingOutbox: backlog.pendingOutbox.toString(),
              leasedOutbox: backlog.leasedOutbox.toString(),
              deadOutbox: backlog.deadOutbox.toString(),
              pendingCommands: backlog.pendingCommands.toString(),
              leasedCommands: backlog.leasedCommands.toString(),
              deadCommands: backlog.deadCommands.toString(),
              expiredCommands: backlog.expiredCommands.toString(),
            },
          }));
          lastHealthAt = now;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

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
            level: 'error',
            message: 'outbox_publish_failed',
            workerId,
            eventId: event.id,
            attempts: event.attempts,
            outcome,
            error: error instanceof Error ? error.message.slice(0, 300) : 'unknown_error',
          }));
        }
      });
      inFlight = 0;
    }
  } finally {
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await Promise.allSettled([redis.quit(), db.$disconnect()]);
    console.info(JSON.stringify({ level: 'info', message: 'delivery_worker_stopped', workerId, published, failed, leaseLost }));
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: 'fatal',
    message: 'delivery_worker_crashed',
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
