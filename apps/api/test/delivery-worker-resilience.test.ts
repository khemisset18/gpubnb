import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FailureTracker,
  RESILIENCE_DEFAULTS,
  backoffWithJitterMs,
  connectWithRetry,
  interruptibleSleep,
} from '../src/delivery-worker-resilience.js';

// Regression for a real gap found while hardening the Delivery Worker for
// private beta: claimOutboxEvents() inside main()'s loop ran outside any
// try/catch, so a transient DB/Redis blip crashed the whole worker process
// immediately with no retry at all.

test('1) a transient failure is retried and the tracker recovers on the next success', () => {
  const tracker = new FailureTracker(20, 10, () => 0.5);
  const decision = tracker.recordFailure();
  assert.equal(decision.action, 'retry');
  if (decision.action === 'retry') assert.ok(decision.delayMs > 0);
  assert.equal(tracker.failureCount, 1);
  tracker.recordSuccess();
  assert.equal(tracker.failureCount, 1, 'a single success must not reset the counter before the stable window');
});

test('2) sustained failures past the threshold deliberately give up instead of retrying forever', () => {
  const tracker = new FailureTracker(5, 10, () => 0.5);
  let lastDecision;
  for (let i = 0; i < 5; i++) lastDecision = tracker.recordFailure();
  assert.deepEqual(lastDecision, { action: 'give_up' });
  assert.equal(tracker.failureCount, 5);
});

test('3) the failure counter resets only after a stable run of consecutive successes', () => {
  const tracker = new FailureTracker(20, 3, () => 0.5);
  tracker.recordFailure();
  tracker.recordFailure();
  assert.equal(tracker.failureCount, 2);
  tracker.recordSuccess();
  tracker.recordSuccess();
  assert.equal(tracker.failureCount, 2, 'not yet reset, only 2 of 3 required stable successes');
  tracker.recordSuccess();
  assert.equal(tracker.failureCount, 0, 'reset after reaching stableResetSuccesses');
});

test('4) a failure occurring mid-stable-run cancels the accumulating success streak', () => {
  const tracker = new FailureTracker(20, 3, () => 0.5);
  tracker.recordFailure();
  tracker.recordSuccess();
  tracker.recordSuccess();
  tracker.recordFailure();
  assert.equal(tracker.failureCount, 2, 'the interrupted streak must not carry over');
  tracker.recordSuccess();
  tracker.recordSuccess();
  assert.equal(tracker.failureCount, 2, 'still short of a fresh 3-success streak');
  tracker.recordSuccess();
  assert.equal(tracker.failureCount, 0);
});

test('backoffWithJitterMs grows exponentially and is capped at the configured max', () => {
  const low = backoffWithJitterMs(1, () => 0, 100, 10_000);
  const high = backoffWithJitterMs(1, () => 1, 100, 10_000);
  assert.ok(low >= 50 && low <= 100, `expected first-attempt backoff in [50,100], got ${low}`);
  assert.ok(high >= 50 && high <= 100, `expected first-attempt backoff in [50,100], got ${high}`);
  const cappedLow = backoffWithJitterMs(20, () => 0, 100, 10_000);
  const cappedHigh = backoffWithJitterMs(20, () => 1, 100, 10_000);
  assert.ok(cappedHigh <= 10_000, 'must never exceed the configured max even with high jitter');
  assert.ok(cappedLow >= 5_000, 'must stay near the capped value once exponent overflows the max');
});

test('RESILIENCE_DEFAULTS are sane bounded defaults', () => {
  assert.ok(RESILIENCE_DEFAULTS.maxConsecutiveFailuresBeforeExit > 0);
  assert.ok(RESILIENCE_DEFAULTS.stableResetSuccesses > 0);
  assert.ok(RESILIENCE_DEFAULTS.backoffMaxMs >= RESILIENCE_DEFAULTS.backoffBaseMs);
});

test('5) interruptibleSleep returns promptly once isStopping flips true, without waiting the full duration', async () => {
  let stopping = false;
  setTimeout(() => { stopping = true; }, 20);
  const start = Date.now();
  await interruptibleSleep(5_000, () => stopping, 10);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1_000, `expected an early return well under 5000ms, took ${elapsed}ms`);
});

test('interruptibleSleep waits out the full duration when never told to stop', async () => {
  const start = Date.now();
  await interruptibleSleep(30, () => false, 10);
  assert.ok(Date.now() - start >= 25);
});

test('6) connectWithRetry retries a flaky startup connection with backoff and eventually connects', async () => {
  let attempts = 0;
  const result = await connectWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('ECONNREFUSED');
    },
    () => false,
    () => {},
    () => 0,
  );
  assert.equal(result, 'connected');
  assert.equal(attempts, 3);
});

test('connectWithRetry stops retrying and returns "stopped" once isStopping flips true', async () => {
  let attempts = 0;
  let stopping = false;
  const result = await connectWithRetry(
    async () => {
      attempts += 1;
      if (attempts === 2) stopping = true;
      throw new Error('ECONNREFUSED');
    },
    () => stopping,
    () => {},
    () => 0,
  );
  assert.equal(result, 'stopped');
  assert.ok(attempts >= 2);
});

test('connectWithRetry logs each failed attempt without throwing', async () => {
  const logs: Array<Record<string, unknown>> = [];
  let attempts = 0;
  await connectWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('boom');
    },
    () => false,
    (event) => logs.push(event),
    () => 0,
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.message, 'delivery_worker_connect_failed');
  assert.equal(logs[0]?.error, 'boom');
});
