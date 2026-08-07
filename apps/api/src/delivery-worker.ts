import { hostname } from 'node:os';
import process from 'node:process';
import {
  BookingStatus,
  JobStatus,
  JobType,
  MachineOperational,
  PaymentStatus,
  PrismaClient,
} from '@prisma/client';
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
import { FailureTracker, connectWithRetry, interruptibleSleep } from './delivery-worker-resilience.js';

const POLL_INTERVAL_MS = 250;
const HEALTH_INTERVAL_MS = 15_000;
const RECONCILE_INTERVAL_MS = 1_000;
const SHUTDOWN_GRACE_MS = 20_000;
const MAX_IN_FLIGHT = 32;
const TERMINAL_JOB_STATUSES: JobStatus[] = [
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
  JobStatus.TIMED_OUT,
  JobStatus.REJECTED,
  JobStatus.QUARANTINED,
];

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

export async function reconcileDevelopmentBookings(db: PrismaClient, now = new Date()): Promise<{
  funded: number;
  queued: number;
  completed: number;
  degraded: number;
}> {
  let funded = 0;
  let queued = 0;
  let completed = 0;
  let degraded = 0;

  if (config.NODE_ENV !== 'production' && config.DEV_PAYMENT_BYPASS === 'true') {
    const waiting = await db.booking.findMany({
      where: {
        status: BookingStatus.AWAITING_DEPOSIT,
        startsAt: { lte: new Date(now.getTime() + 5 * 60_000) },
        endsAt: { gt: now },
      },
      select: { id: true, quotedLamports: true },
      take: 25,
      orderBy: { createdAt: 'asc' },
    });
    for (const booking of waiting) {
      const changed = await db.$transaction(async (tx) => {
        const update = await tx.booking.updateMany({
          where: { id: booking.id, status: BookingStatus.AWAITING_DEPOSIT },
          data: { status: BookingStatus.FUNDED, depositSignature: `dev-bypass:${booking.id}` },
        });
        if (update.count !== 1) return false;
        await tx.payment.upsert({
          where: { bookingId: booking.id },
          update: { grossLamports: booking.quotedLamports, status: PaymentStatus.ESCROW_FUNDED },
          create: { bookingId: booking.id, grossLamports: booking.quotedLamports, status: PaymentStatus.ESCROW_FUNDED },
        });
        return true;
      });
      if (changed) funded += 1;
    }
  }

  const readyBookings = await db.booking.findMany({
    where: {
      status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING] },
      startsAt: { lte: new Date(now.getTime() + 5 * 60_000) },
      endsAt: { gt: now },
      listing: {
        machine: {
          connectivity: 'ONLINE',
          lastCudaProbeOk: true,
          dockerAvailable: true,
          nvidiaRuntimeAvailable: true,
        },
      },
    },
    select: { id: true, buyerId: true, listing: { select: { machineId: true } } },
    take: 50,
    orderBy: { startsAt: 'asc' },
  });

  for (const booking of readyBookings) {
    const existing = await db.job.findFirst({
      where: { bookingId: booking.id, type: JobType.GPU_DIAGNOSTIC },
      select: { id: true },
    });
    if (existing) continue;
    const created = await db.$transaction(async (tx) => {
      const reserved = await tx.booking.updateMany({
        where: { id: booking.id, status: { in: [BookingStatus.FUNDED, BookingStatus.STARTING] } },
        data: { status: BookingStatus.STARTING },
      });
      if (reserved.count !== 1) return false;
      await tx.job.create({
        data: {
          bookingId: booking.id,
          renterId: booking.buyerId,
          machineId: booking.listing.machineId,
          type: JobType.GPU_DIAGNOSTIC,
          parameters: {
            timeoutSeconds: 120,
            purpose: 'FIRST_RENTAL_E2E',
            ...(config.DEV_DIAGNOSTIC_IMAGE ? { diagnosticImage: config.DEV_DIAGNOSTIC_IMAGE } : {}),
          },
        },
      });
      await tx.machine.update({
        where: { id: booking.listing.machineId },
        data: { operational: MachineOperational.RESERVED },
      });
      return true;
    });
    if (created) queued += 1;
  }

  const finishedJobs = await db.job.findMany({
    where: {
      type: JobType.GPU_DIAGNOSTIC,
      status: { in: TERMINAL_JOB_STATUSES },
      booking: { status: { in: [BookingStatus.STARTING, BookingStatus.ACTIVE] } },
    },
    select: { id: true, status: true, bookingId: true, machineId: true, result: true },
    take: 50,
    orderBy: { finishedAt: 'asc' },
  });

  for (const job of finishedJobs) {
    const success = job.status === JobStatus.COMPLETED
      && typeof job.result === 'object'
      && job.result !== null
      && (job.result as { gpuDetected?: unknown }).gpuDetected === true;
    const changed = await db.$transaction(async (tx) => {
      const bookingUpdate = await tx.booking.updateMany({
        where: {
          id: job.bookingId,
          status: { in: [BookingStatus.STARTING, BookingStatus.ACTIVE] },
        },
        data: { status: success ? BookingStatus.COMPLETED : BookingStatus.DEGRADED },
      });
      if (bookingUpdate.count !== 1) return false;
      await tx.machine.update({
        where: { id: job.machineId },
        data: { operational: success ? MachineOperational.AVAILABLE : MachineOperational.DEGRADED },
      });
      return true;
    });
    if (changed) {
      if (success) completed += 1;
      else degraded += 1;
    }
  }

  return { funded, queued, completed, degraded };
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
  let lastReconcileAt = 0;

  const stop = (): void => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    const connected = await connectWithRetry(
      async () => { await redis.connect(); await db.$connect(); },
      () => stopping,
      (event) => console.error(JSON.stringify(event)),
    );
    if (connected === 'stopped') {
      console.info(JSON.stringify({ level: 'info', message: 'delivery_worker_stopped_before_connect', workerId }));
      return;
    }
    console.info(JSON.stringify({ level: 'info', message: 'delivery_worker_started', workerId }));

    const tracker = new FailureTracker();
    while (!stopping) {
      try {
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

        const events = await claimOutboxEvents(db, workerId, 500, 45);
        inFlight = events.length;
        if (events.length === 0) {
          if (now - lastHealthAt >= HEALTH_INTERVAL_MS) {
            const backlog = await deliveryBacklog(db);
            console.info(JSON.stringify({
              level: 'info', message: 'delivery_worker_health', workerId, published, failed, leaseLost,
              backlog: Object.fromEntries(Object.entries(backlog).map(([key, value]) => [key, value.toString()])),
            }));
            lastHealthAt = now;
          }
          tracker.recordSuccess();
          await interruptibleSleep(POLL_INTERVAL_MS, () => stopping);
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
              level: 'error', message: 'outbox_publish_failed', workerId, eventId: event.id,
              attempts: event.attempts, outcome,
              error: error instanceof Error ? error.message.slice(0, 300) : 'unknown_error',
            }));
          }
        });
        inFlight = 0;
        tracker.recordSuccess();
      } catch (error) {
        // A per-event publish failure is already caught and rescheduled
        // above without reaching here — this only catches failures in the
        // iteration's own plumbing (e.g. claimOutboxEvents/reconcile losing
        // the DB/Redis connection outright), which used to crash the whole
        // process immediately with no retry at all.
        const decision = tracker.recordFailure();
        console.error(JSON.stringify({
          level: 'error', message: 'delivery_worker_iteration_failed', workerId,
          consecutiveFailures: tracker.failureCount,
          error: error instanceof Error ? error.message.slice(0, 300) : 'unknown_error',
        }));
        if (decision.action === 'give_up') {
          throw new Error(`delivery_worker_giving_up_after_sustained_failures:${tracker.failureCount}`);
        }
        await interruptibleSleep(decision.delayMs, () => stopping);
      }
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

if (process.env.NODE_ENV !== 'test') {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({
      level: 'fatal', message: 'delivery_worker_crashed',
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
