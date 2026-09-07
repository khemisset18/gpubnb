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
  | { status: 'executed'; value: T; leaseLost: boolean }
  | { status: 'skipped_locked' };

export type DistributedTaskLeaseOptions = {
  ttlMs?: number;
  renewalMs?: number;
  keyPrefix?: string;
};

function taskKey(name: string, prefix: string): string {
  if (!/^[a-z0-9][a-z0-9:_-]{1,119}$/.test(name)) throw new Error('invalid_distributed_task_name');
  return `${prefix}${name}`;
}

export async function runWithDistributedTaskLease<T>(
  redis: Pick<Redis, 'set' | 'eval'>,
  name: string,
  task: () => Promise<T>,
  options: DistributedTaskLeaseOptions = {},
): Promise<DistributedTaskLeaseResult<T>> {
  const ttlMs = Math.max(5_000, Math.min(options.ttlMs ?? 30_000, 300_000));
  const renewalMs = Math.max(1_000, Math.min(options.renewalMs ?? Math.floor(ttlMs / 3), Math.floor(ttlMs / 2)));
  const key = taskKey(name, options.keyPrefix ?? 'gpubnb:task-lease:');
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') return { status: 'skipped_locked' };

  let stopped = false;
  let leaseLost = false;
  let renewalInFlight = false;
  const renew = async (): Promise<void> => {
    if (stopped || renewalInFlight || leaseLost) return;
    renewalInFlight = true;
    try {
      const result = Number(await redis.eval(RENEW_SCRIPT, 1, key, token, String(ttlMs)));
      if (result !== 1) leaseLost = true;
    } catch {
      // A transient Redis failure does not prove ownership was lost. The next
      // renewal will retry while the original TTL still fences other workers.
    } finally {
      renewalInFlight = false;
    }
  };
  const timer = setInterval(() => { void renew(); }, renewalMs);
  timer.unref?.();

  try {
    const value = await task();
    return { status: 'executed', value, leaseLost };
  } finally {
    stopped = true;
    clearInterval(timer);
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch {
      // Release failure is bounded by TTL. Never issue an unconditional DEL,
      // because a successor may already own the same task lease.
    }
  }
}
