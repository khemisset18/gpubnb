import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL;
const integration = redisUrl ? test : test.skip;

integration('configured Redis provides the atomic capabilities required by GPUbnb', async () => {
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 2, enableReadyCheck: true });
  const prefix = `gpubnb:test:redis-capabilities:${crypto.randomUUID()}`;
  const oneShot = `${prefix}:getdel`;
  const lease = `${prefix}:lease`;
  const list = `${prefix}:list`;
  const stream = `${prefix}:stream`;

  try {
    assert.equal(await redis.ping(), 'PONG');

    assert.equal(await redis.set(oneShot, 'credential', 'EX', 30, 'NX'), 'OK');
    assert.equal(await redis.set(oneShot, 'replacement', 'EX', 30, 'NX'), null, 'SET NX must reject a concurrent owner');
    assert.equal(await redis.getdel(oneShot), 'credential');
    assert.equal(await redis.getdel(oneShot), null, 'GETDEL must consume exactly once');

    const owner = crypto.randomUUID();
    assert.equal(await redis.set(lease, owner, 'PX', 30_000, 'NX'), 'OK');
    const renewed = Number(await redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`,
      1,
      lease,
      owner,
      '30000',
    ));
    assert.equal(renewed, 1, 'Lua compare-and-renew must preserve lease ownership');
    const wrongRelease = Number(await redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
      1,
      lease,
      'not-the-owner',
    ));
    assert.equal(wrongRelease, 0);
    assert.equal(await redis.get(lease), owner, 'a non-owner must not delete a lease');

    await redis.lpush(list, 'first');
    await redis.lpush(list, 'second');
    assert.equal(await redis.rpop(list), 'first');
    assert.equal(await redis.rpop(list), 'second');

    const streamId = await redis.xadd(stream, '*', 'eventId', crypto.randomUUID(), 'eventType', 'redis_contract_test');
    assert.ok(streamId && /^\d+-\d+$/.test(streamId), 'Redis Streams XADD must return a stream id');
  } finally {
    await redis.del(oneShot, lease, list, stream).catch(() => undefined);
    redis.disconnect();
  }
});
