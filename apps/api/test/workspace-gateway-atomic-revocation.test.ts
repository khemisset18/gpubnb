import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Redis } from 'ioredis';

const gateway = readFileSync(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
function script(name: string): string {
  const declaration = new RegExp('const ' + name + '=\\x60([\\s\\S]*?)\\x60;');
  const match = gateway.match(declaration);
  assert.ok(match, name + ' must be present in real API code');
  return match[1]!;
}
const deduped = script('ENQUEUE_DEDUPED_WS_FRAME_SCRIPT');
const bounded = script('ENQUEUE_BOUND_WS_FRAME_SCRIPT');
const machine = script('ENQUEUE_BOUND_MACHINE_RELAY_SCRIPT');

test('both Agent frame paths atomically require the original Redis channel binding', () => {
  assert.match(deduped, /redis\.call\('GET', KEYS\[4\]\) ~= ARGV\[7\]/);
  assert.match(bounded, /redis\.call\('GET', KEYS\[3\]\) ~= ARGV\[6\]/);
  assert.match(machine, /redis\.call\('GET', KEYS\[3\]\) ~= ARGV\[6\]/);
  assert.match(gateway, /enqueueBoundNativeMachineRelay\(redis,row\.machineId,channelId,channelBinding,relay\)/);
  assert.match(gateway, /redis\.eval\(ENQUEUE_DEDUPED_WS_FRAME_SCRIPT,4,markerKey,wsInputKey\(channelId\),wsInputBytesKey\(channelId\),wsChannelKey\(channelId\)/);
  assert.match(gateway, /redis\.eval\(ENQUEUE_BOUND_WS_FRAME_SCRIPT,3,wsInputKey\(channelId\),wsInputBytesKey\(channelId\),wsChannelKey\(channelId\)/);
});

const withRedis = process.env.REDIS_URL ? test : test.skip;
withRedis('real Redis: revoked/replaced native channel cannot enqueue frames, even after a stale pre-read', async () => {
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
  const prefix = 'gpubnb:test:stage4:frame-fence:' + crypto.randomUUID();
  const bindingKey = prefix + ':channel';
  const queueKey = prefix + ':queue';
  const bytesKey = prefix + ':bytes';
  const machineQueueKey = prefix + ':machine-queue';
  const machineBytesKey = prefix + ':machine-queue-bytes';
  const marker1 = prefix + ':seen:1';
  const marker2 = prefix + ':seen:2';
  const binding = JSON.stringify({ sessionId:'session-a',machineId:'machine-a',runtimeBackend:'WINDOWS_NATIVE' });
  const changed = JSON.stringify({ sessionId:'session-b',machineId:'machine-b',runtimeBackend:'WINDOWS_NATIVE' });
  const payload = JSON.stringify({dataBase64:'AA==',binary:true,close:false});

  async function sendSingle(expected = binding) {
    return Number(await redis.eval(bounded, 3, queueKey, bytesKey, bindingKey,
      payload, '120', String(Buffer.byteLength(payload)), '512', '16777216', expected));
  }
  async function sendMachine(expected = binding) {
    const relay = JSON.stringify({id:'request',kind:'ws_send',channelId:'channel',sessionId:'session-a',binary:true,dataBase64:'AA=='});
    return Number(await redis.eval(machine, 3, machineQueueKey, machineBytesKey, bindingKey,
      relay, '120', String(Buffer.byteLength(relay)), '512', '33554432', expected));
  }
  async function sendBatch(marker: string, expected = binding) {
    return Number(await redis.eval(deduped, 4, marker, queueKey, bytesKey, bindingKey,
      '180', '120', payload, String(Buffer.byteLength(payload)), '512', '16777216', expected));
  }

  try {
    assert.equal(await redis.set(bindingKey, binding, 'EX', 60), 'OK');
    assert.equal(await sendSingle(), 1);
    assert.equal(await sendBatch(marker1), 1);
    assert.equal(await sendMachine(), 1);
    assert.equal(await redis.llen(queueKey), 2);
    assert.equal(await redis.llen(machineQueueKey), 1);

    // A request read the old binding, then awaited a DB operation.
    // Redis revokes the channel before the request reaches EVAL.
    await redis.del(bindingKey);
    assert.equal(await sendSingle(), -2, 'no new single frame after revoked binding');
    assert.equal(await sendBatch(marker2), -2, 'no new batch frame after revoked binding');
    assert.equal(await sendMachine(), -2, 'no browser input may enter Agent queue after revocation');
    assert.equal(await redis.llen(machineQueueKey), 1);
    assert.equal(await redis.exists(marker2), 0, 'revoked frames must not claim dedupe markers');
    assert.equal(await redis.llen(queueKey), 2, 'revocation must not add buffered frames');

    // Replacing a channel binding must not resurrect an older authorization.
    await redis.set(bindingKey, changed, 'EX', 60);
    assert.equal(await sendSingle(binding), -2);
    assert.equal(await sendBatch(marker2, binding), -2);
    assert.equal(await sendMachine(binding), -2);
    assert.equal(await redis.llen(queueKey), 2);
    assert.equal(await sendSingle(changed), 1, 'only the current exact binding can publish');
    assert.equal(await sendBatch(marker2, changed), 1);
    assert.equal(await sendMachine(changed), 1);
    assert.equal(await sendBatch(marker2, changed), 0, 'completed frame retries remain deduped');
  } finally {
    await redis.del(bindingKey, queueKey, bytesKey, machineQueueKey, machineBytesKey, marker1, marker2).catch(() => undefined);
    redis.disconnect();
  }
});
