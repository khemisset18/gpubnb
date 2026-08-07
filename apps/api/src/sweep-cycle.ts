import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { config } from './config.js';
import { sweepOfflineMachines, type OfflineSweepResult } from './offline-sweep-service.js';
import { sweepStaleJobs, type JobStalenessSweepResult } from './job-staleness-sweep.js';
import { acquireSweepLock, type SweepLockHandle } from './sweep-lock.js';

// Split out from sweep-scheduler.ts deliberately: this module has no process-level
// side effects (no main(), nothing runs on import), so it is safe for server.ts (the
// API's HTTP process) to import runSweepCycle directly for the manual
// POST /internal/sweep-offline trigger without ever pulling in — let alone starting —
// the standalone scheduler loop. Importing sweep-scheduler.ts itself into the API
// process would have silently started a second, hidden scheduler inside the API,
// exactly what a dedicated worker process is meant to avoid.

export type SweepCycleOutcome =
  | { outcome: 'ran'; offline: OfflineSweepResult; staleJobs: JobStalenessSweepResult }
  | { outcome: 'lock_held' }
  | { outcome: 'failed'; error: unknown };

/**
 * The single code path that performs a sweep: acquires the distributed lock, runs
 * both sweeps, and always releases the lock (including on failure). Shared by the
 * scheduler's own loop (sweep-scheduler.ts) and by POST /internal/sweep-offline
 * (server.ts), so every possible trigger — scheduled or a manual ops call — goes
 * through the same lock and can never run two sweeps concurrently.
 */
export async function runSweepCycle(
  db: PrismaClient,
  redis: Redis,
  now: Date,
  // Only ever overridden by tests, to run real lock-contention scenarios against a
  // shared Redis without colliding on the one production lock key.
  lockKey?: string,
): Promise<SweepCycleOutcome> {
  // Lock acquisition itself lives inside the try/catch: a Redis outage while trying
  // to acquire must produce the same clean 'failed' outcome as a DB outage mid-sweep,
  // not an uncaught rejection that every call site would need to remember to wrap.
  let lock: SweepLockHandle | null = null;
  try {
    lock = await acquireSweepLock(redis, config.SWEEP_LOCK_TTL_MS, undefined, lockKey);
    if (!lock) return { outcome: 'lock_held' };
    const offline = await sweepOfflineMachines(db, now, config.HEARTBEAT_OFFLINE_SECONDS);
    const staleJobs = await sweepStaleJobs(db, now, config.JOB_STALE_AFTER_SECONDS);
    return { outcome: 'ran', offline, staleJobs };
  } catch (error) {
    return { outcome: 'failed', error };
  } finally {
    await lock?.release().catch(() => {});
  }
}
