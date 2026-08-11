import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForGatewayQueueItem } from '../src/gateway-queue.js';

test('returns a queued gateway item without sleeping', async () => {
  let sleeps = 0;
  const result = await waitForGatewayQueueItem(
    { rpop: async () => '{"kind":"http"}' },
    'gateway:test',
    { sleep: async () => { sleeps += 1; } },
  );
  assert.equal(result, '{"kind":"http"}');
  assert.equal(sleeps, 0);
});

test('waits efficiently until a gateway item appears', async () => {
  let clock = 0;
  let calls = 0;
  const result = await waitForGatewayQueueItem(
    { rpop: async () => (++calls === 3 ? 'ready' : null) },
    'gateway:test',
    {
      timeoutMs: 1_000,
      pollMs: 100,
      now: () => clock,
      sleep: async milliseconds => { clock += milliseconds; },
    },
  );
  assert.equal(result, 'ready');
  assert.equal(calls, 3);
  assert.equal(clock, 200);
});

test('returns null at the long-poll deadline without a hot loop', async () => {
  let clock = 0;
  let calls = 0;
  const result = await waitForGatewayQueueItem(
    { rpop: async () => { calls += 1; return null; } },
    'gateway:test',
    {
      timeoutMs: 250,
      pollMs: 100,
      now: () => clock,
      sleep: async milliseconds => { clock += milliseconds; },
    },
  );
  assert.equal(result, null);
  assert.equal(clock, 250);
  assert.equal(calls, 4);
});
