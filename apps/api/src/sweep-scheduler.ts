import { hostname } from 'node:os';
import process from 'node:process';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { runSweepCycle, type SweepCycleOutcome } from './sweep-cycle.js';
import { FailureTracker, connectWithRetry, interruptibleSleep } from './delivery-worker-resilience.js';

// Dedicated sweep task, run as its own process — this deliberately replaces having
// GPUbnb Phase 5/RC1 risk R2 ("no scheduler for /internal/sweep-offline") open: before
// this file existed, that route only ever ran when something happened to call it by
// hand. There is no setInterval hidden inside the API's HTTP process; this is a
// separate entrypoint (own `node dist/sweep-scheduler.js` process, its own render.yaml
// `type: worker` service), matching how delivery-worker.ts is already deployed. The
// actual sweep logic (runSweepCycle) lives in sweep-cycle.ts, which has no
// process-level side effects, so server.ts can reuse it for a manual trigger without
// ever importing — and thereby silently starting — this file's main() loop.

function schedulerIdentity(): string {
  const suffix = process.env.SWEEP_SCHEDULER_ID ?? `${hostname()}_${process.pid}`;
  return `sweep_${suffix}`.replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 120);
}

type Totals = {
  cycles: number;
  lockSkipped: number;
  failed: number;
  jobsProcessed: number;
  machinesProcessed: number;
  machinesQuarantined: number;
};

async function main(): Promise<void> {
  const db = new PrismaClient();
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true, lazyConnect: true });
  const schedulerId = schedulerIdentity();
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const totals: Totals = { cycles: 0, lockSkipped: 0, failed: 0, jobsProcessed: 0, machinesProcessed: 0, machinesQuarantined: 0 };

  try {
    const connected = await connectWithRetry(
      async () => { await redis.connect(); await db.$connect(); },
      () => stopping,
      (event) => console.error(JSON.stringify(event)),
    );
    if (connected === 'stopped') {
      console.info(JSON.stringify({ level: 'info', message: 'sweep_scheduler_stopped_before_connect', schedulerId }));
      return;
    }
    console.info(JSON.stringify({
      level: 'info', message: 'sweep_scheduler_started', schedulerId,
      intervalMs: config.SWEEP_INTERVAL_MS, lockTtlMs: config.SWEEP_LOCK_TTL_MS,
    }));

    const tracker = new FailureTracker();
    while (!stopping) {
      const cycleStart = Date.now();
      let result: SweepCycleOutcome;
      try {
        result = await runSweepCycle(db, redis, new Date(cycleStart));
      } catch (error) {
        result = { outcome: 'failed', error };
      }

      if (result.outcome === 'ran') {
        totals.cycles += 1;
        const jobsProcessed = result.offline.jobsCancelled + result.staleJobs.jobsTimedOut + result.staleJobs.jobsFailed;
        const machinesProcessed = result.offline.machinesOffline + result.staleJobs.machinesQuarantined;
        totals.jobsProcessed += jobsProcessed;
        totals.machinesProcessed += machinesProcessed;
        totals.machinesQuarantined += result.staleJobs.machinesQuarantined;
        tracker.recordSuccess();
        console.info(JSON.stringify({
          level: 'info', message: 'sweep_cycle_completed', schedulerId,
          durationMs: Date.now() - cycleStart,
          jobsProcessed, machinesProcessed, machinesQuarantined: result.staleJobs.machinesQuarantined,
          offline: { ...result.offline, cutoff: result.offline.cutoff.toISOString() },
          staleJobs: { ...result.staleJobs, cutoff: result.staleJobs.cutoff.toISOString() },
          totals,
        }));
        await interruptibleSleep(config.SWEEP_INTERVAL_MS, () => stopping);
      } else if (result.outcome === 'lock_held') {
        totals.lockSkipped += 1;
        // Another instance already owns this cycle — not this instance's failure.
        tracker.recordSuccess();
        console.info(JSON.stringify({ level: 'info', message: 'sweep_cycle_skipped_lock_held', schedulerId, totals }));
        await interruptibleSleep(config.SWEEP_INTERVAL_MS, () => stopping);
      } else {
        totals.failed += 1;
        const decision = tracker.recordFailure();
        console.error(JSON.stringify({
          level: 'error', message: 'sweep_cycle_failed', schedulerId,
          consecutiveFailures: tracker.failureCount,
          error: result.error instanceof Error ? result.error.message.slice(0, 300) : 'unknown_error',
          totals,
        }));
        if (decision.action === 'give_up') {
          throw new Error(`sweep_scheduler_giving_up_after_sustained_failures:${tracker.failureCount}`);
        }
        // Backoff replaces the normal interval wait for this iteration — next cycle
        // (this one, once the backoff elapses) is the recovery attempt.
        await interruptibleSleep(decision.delayMs, () => stopping);
      }
    }
  } finally {
    await Promise.allSettled([redis.quit(), db.$disconnect()]);
    console.info(JSON.stringify({ level: 'info', message: 'sweep_scheduler_stopped', schedulerId, totals }));
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({
      level: 'fatal', message: 'sweep_scheduler_crashed',
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
