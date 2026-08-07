import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

// Distributed mutex so at most one process runs a sweep cycle at a time, even if the
// scheduler is horizontally scaled or a manual /internal/sweep-offline call races a
// scheduled cycle.
//
// This is defense-in-depth, not the sole correctness guarantee: sweepOfflineMachines
// and sweepStaleJobs are already independently safe under real concurrency (every
// updateMany is guarded by the exact source status it read, inside a Serializable
// transaction) — see offline-sweep-service.ts and job-staleness-sweep.ts. What the lock
// adds is avoiding wasted duplicate Serializable transactions/connection pressure and
// giving each cycle a single, unambiguous log/metrics stream.
//
// SET key value PX ttl NX is atomic in Redis, so acquisition itself needs no script.
// The TTL means a holder that crashes or is killed mid-cycle self-heals: the lock
// simply expires, no stale-lock cleanup logic is needed. Release is a compare-token-
// then-delete Lua script (not a plain DEL) so a holder can never delete a lock it no
// longer owns — e.g. its own TTL expired under a very slow cycle and a new holder
// already acquired it; a naive DEL there would delete the new holder's lock.

export const SWEEP_LOCK_KEY = 'gpubnb:sweep-scheduler:lock';

const RELEASE_IF_OWNER_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

export type SweepLockHandle = {
  readonly token: string;
  /** Resolves true if this call actually deleted the lock, false if it had already expired or been taken over. */
  release: () => Promise<boolean>;
};

export function generateSweepLockToken(): string {
  return randomBytes(16).toString('hex');
}

export async function acquireSweepLock(
  redis: Redis,
  ttlMs: number,
  token: string = generateSweepLockToken(),
  // Only ever overridden by tests, so independent test files/cases can run real
  // concurrent-lock scenarios against a shared Redis without colliding on the one
  // production key.
  lockKey: string = SWEEP_LOCK_KEY,
): Promise<SweepLockHandle | null> {
  const acquired = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') return null;
  let released = false;
  return {
    token,
    release: async () => {
      if (released) return false;
      released = true;
      const result = await redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, lockKey, token);
      return result === 1;
    },
  };
}
