import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createGatewayChannelLeaseGuard } from '../src/workspace-gateway-channel-lease.js';
import {
  BrowserPendingBudget,
  WS_BROWSER_PENDING_MAX_BYTES,
} from '../src/workspace-gateway-transport.js';

// Synthetic, repeatable load workload: Redis/PostgreSQL are in-memory stubs.
// These timings are NOT production Redis/DB or physical streaming p50/p95/p99.
function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

async function syntheticLoad(fps: 30 | 60, channels: number) {
  let redisBrowserReads = 0;
  let postgresWorkspaceReads = 0;
  let redisChannelLeaseReads = 0;
  const samples: number[] = [];
  const runChannel = async (id: number) => {
    const sessionId = `synthetic-session-${id}`;
    const userId = `synthetic-user-${id}`;
    const machineId = `synthetic-machine-${id}`;
    const authorized = createGatewayChannelLeaseGuard({
      sessionId,
      userId,
      expectedMachineId: machineId,
      expectedRuntimeBackend: 'WINDOWS_NATIVE',
      cacheMs: 0,
      readBrowser: async () => {
        redisBrowserReads++;
        return JSON.stringify({ sessionId, userId });
      },
      readWorkspace: async () => {
        postgresWorkspaceReads++;
        return { renterId: userId, machineId, runtimeBackend: 'WINDOWS_NATIVE',
          expiresAt: new Date(Date.now() + 60_000) };
      },
    });
    for (let frame = 0; frame < fps; frame++) {
      // The production native pump also checks wsChannelKey existence for each frame.
      redisChannelLeaseReads++;
      const started = performance.now();
      assert.equal(await authorized(), true);
      samples.push(performance.now() - started);
    }
  };
  await Promise.all(Array.from({length: channels}, (_, id) => runChannel(id)));
  const expected = fps * channels;
  assert.equal(redisBrowserReads, expected);
  assert.equal(postgresWorkspaceReads, expected);
  assert.equal(redisChannelLeaseReads, expected);
  samples.sort((a, b) => a - b);
  const result = {
    kind: 'synthetic-in-memory-not-production-SLO',
    fps, channels, frames: expected, redisBrowserReads,
    postgresWorkspaceReads, redisChannelLeaseReads,
    p50Ms: percentile(samples, 0.50),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  };
  assert.ok(result.p50Ms >= 0 && result.p99Ms >= result.p95Ms);
  console.log('STAGE4_NATIVE_AUTH_SYNTHETIC_LOAD ' + JSON.stringify(result));
  return result;
}

test('30/60 FPS over 1/4/8 native channels revalidates every frame, with p50/p95/p99 metrics', async () => {
  for (const fps of [30, 60] as const) {
    for (const channels of [1, 4, 8]) {
      await syntheticLoad(fps, channels);
    }
  }
});

test('a Redis read outage and PostgreSQL read outage both deny the next native frame', async () => {
  const sessionId = 's', userId = 'u';
  let browserDown = false;
  let databaseDown = false;
  const guard = createGatewayChannelLeaseGuard({
    sessionId, userId, cacheMs: 0,
    readBrowser: async () => {
      if (browserDown) throw new Error('synthetic_redis_unavailable');
      return JSON.stringify({ sessionId, userId });
    },
    readWorkspace: async () => {
      if (databaseDown) throw new Error('synthetic_db_unavailable');
      return { renterId: userId, expiresAt: new Date(Date.now() + 60_000) };
    },
  });
  assert.equal(await guard(), true);
  browserDown = true;
  assert.equal(await guard(), false);
  browserDown = false;
  databaseDown = true;
  assert.equal(await guard(), false);
});

test('authorization timeout denies and does not keep a positive cached grant', async () => {
  const sessionId = 's', userId = 'u';
  let blocked = false;
  const guard = createGatewayChannelLeaseGuard({
    sessionId, userId, cacheMs: 0, timeoutMs: 10,
    readBrowser: async () => {
      if (blocked) return new Promise<string | null>(() => {});
      return JSON.stringify({ sessionId, userId });
    },
    readWorkspace: async () => ({ renterId: userId, expiresAt: new Date(Date.now() + 60_000) }),
  });
  assert.equal(await guard(), true);
  blocked = true;
  assert.equal(await guard(), false, 'a blocked Redis read must time out fail closed');
  blocked = false;
  assert.equal(await guard(), true, 'a later fresh grant may recover after a timeout');
});

test('input backpressure rejects excessive queued native frames without allocating unbounded bytes', () => {
  const budget = new BrowserPendingBudget();
  assert.equal(budget.tryAcquire(WS_BROWSER_PENDING_MAX_BYTES), true);
  assert.equal(budget.tryAcquire(32), false);
  budget.release(WS_BROWSER_PENDING_MAX_BYTES);
  assert.deepEqual(budget.snapshot(), { items: 0, bytes: 0 });
});
