import crypto from 'node:crypto';
import type { Redis } from 'ioredis';

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export type DistributedTaskLeaseResult<T> =
  | { acquired: false }
  | { acquired: true; value: T; leaseLost: boolean };

export async function runWithDistributedTaskLease<T>(
  redis: Pick<Redis, 'set' | 'eval'>,
  key: string,
  leaseMs: number,
  task: () => Promise<T>,
): Promise<DistributedTaskLeaseResult<T>> {
  if (!Number.isInteger(leaseMs) || leaseMs < 3_000) throw new Error('distributed_task_lease_too_short');
  if (!/^gpubnb:task:[a-z0-9:_-]+$/i.test(key)) throw new Error('invalid_distributed_task_lease_key');

  const token = crypto.randomBytes(24).toString('hex');
  const acquired = await redis.set(key, token, 'PX', leaseMs, 'NX');
  if (acquired !== 'OK') return { acquired: false };

  let leaseLost = false;
  let renewing = false;
  const renewEveryMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    if (renewing || leaseLost) return;
    renewing = true;
    void redis.eval(RENEW_SCRIPT, 1, key, token, String(leaseMs))
      .then(result => {
        if (Number(result) !== 1) leaseLost = true;
      })
      .catch(() => {
        leaseLost = true;
      })
      .finally(() => {
        renewing = false;
      });
  }, renewEveryMs);
  timer.unref?.();

  try {
    const value = await task();
    return { acquired: true, value, leaseLost };
  } finally {
    clearInterval(timer);
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch {
      // Lease expiry/loss is fail-safe: never delete a lock we no longer own.
    }
  }
}
