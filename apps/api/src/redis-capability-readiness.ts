import crypto from 'node:crypto';
import type { Redis } from 'ioredis';

export const REDIS_CAPABILITY_CACHE_MS = 60_000;

type RedisCapabilityClient = Pick<
  Redis,
  'set' | 'getdel' | 'eval' | 'get' | 'lpush' | 'rpop' | 'xadd' | 'del'
>;

function fail(capability: string, detail?: unknown): never {
  const suffix = detail === undefined ? '' : `:${String(detail).slice(0, 160)}`;
  throw new Error(`redis_capability_unavailable:${capability}${suffix}`);
}

export async function verifyRedisCapabilities(redis: RedisCapabilityClient): Promise<void> {
  const prefix = `gpubnb:ready:${crypto.randomUUID()}`;
  const oneShot = `${prefix}:getdel`;
  const lease = `${prefix}:lease`;
  const list = `${prefix}:list`;
  const stream = `${prefix}:stream`;

  try {
    if (await redis.set(oneShot, 'credential', 'EX', 30, 'NX') !== 'OK') fail('set-nx');
    if (await redis.set(oneShot, 'replacement', 'EX', 30, 'NX') !== null) fail('set-nx-exclusivity');
    if (await redis.getdel(oneShot) !== 'credential') fail('getdel-first-consume');
    if (await redis.getdel(oneShot) !== null) fail('getdel-one-shot');

    const owner = crypto.randomUUID();
    if (await redis.set(lease, owner, 'PX', 30_000, 'NX') !== 'OK') fail('lease-set-nx');
    const renewed = Number(await redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`,
      1,
      lease,
      owner,
      '30000',
    ));
    if (renewed !== 1) fail('lua-compare-renew', renewed);
    const wrongRelease = Number(await redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
      1,
      lease,
      'not-the-owner',
    ));
    if (wrongRelease !== 0 || await redis.get(lease) !== owner) fail('lua-owner-fence');

    await redis.lpush(list, 'first');
    await redis.lpush(list, 'second');
    if (await redis.rpop(list) !== 'first') fail('list-fifo-first');
    if (await redis.rpop(list) !== 'second') fail('list-fifo-second');

    const streamId = await redis.xadd(
      stream,
      '*',
      'eventId',
      crypto.randomUUID(),
      'eventType',
      'readiness_probe',
    );
    if (!streamId || !/^\d+-\d+$/.test(streamId)) fail('streams-xadd', streamId);
  } finally {
    await redis.del(oneShot, lease, list, stream).catch(() => undefined);
  }
}

export function createRedisCapabilityReadiness(
  redis: RedisCapabilityClient,
  cacheMs = REDIS_CAPABILITY_CACHE_MS,
  now: () => number = Date.now,
): () => Promise<void> {
  let validUntil = 0;
  let inFlight: Promise<void> | null = null;

  return async () => {
    if (now() < validUntil) return;
    if (inFlight) return inFlight;

    inFlight = verifyRedisCapabilities(redis)
      .then(() => {
        validUntil = now() + Math.max(0, cacheMs);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
