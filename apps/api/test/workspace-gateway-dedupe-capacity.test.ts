import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');

test('an already accepted websocket frame is deduped before queue capacity rejection', () => {
  const match = api.match(/const ENQUEUE_DEDUPED_WS_FRAME_SCRIPT=`([\s\S]*?)`;/);
  assert.ok(match, 'deduped websocket enqueue Lua script must exist');

  const script = match[1];
  const dedupeCheck = script.indexOf("redis.call('EXISTS', KEYS[1])");
  const capacityCheck = script.indexOf("local count = redis.call('LLEN', KEYS[2])");
  const dedupeInsert = script.indexOf("redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX')");
  const enqueue = script.indexOf("redis.call('LPUSH', KEYS[2], ARGV[3])");

  assert.notEqual(dedupeCheck, -1, 'script must check whether frameId was already accepted');
  assert.notEqual(capacityCheck, -1, 'script must retain bounded queue capacity checks');
  assert.notEqual(dedupeInsert, -1, 'script must atomically claim a new frameId');
  assert.notEqual(enqueue, -1, 'script must enqueue a newly accepted frame');
  assert.ok(
    dedupeCheck < capacityCheck,
    'duplicate retries must return idempotent success before a full queue can reject them',
  );
  assert.ok(dedupeInsert < enqueue, 'a new frameId must be claimed before its payload is enqueued');
});
