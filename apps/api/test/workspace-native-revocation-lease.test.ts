import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatewayChannelLeaseGuard } from '../src/workspace-gateway-channel-lease.js';

test('native zero-cache grant denies immediately on next check after revocation', async () => {
  const sessionId = 'native-session';
  const userId = 'renter';
  let nowMs = 1_000;
  let browserActive = true;
  let workspaceActive = true;
  let browserReads = 0;
  let workspaceReads = 0;

  const authorized = createGatewayChannelLeaseGuard({
    sessionId,
    userId,
    cacheMs: 0,
    now: () => nowMs,
    readBrowser: async () => {
      browserReads++;
      return browserActive ? JSON.stringify({ sessionId, userId }) : null;
    },
    readWorkspace: async () => {
      workspaceReads++;
      return workspaceActive
        ? { renterId: userId, expiresAt: new Date(60_000) }
        : null;
    },
  });

  assert.equal(await authorized(), true);
  // Freeze the clock: a positive cached response must not outlive its check.
  browserActive = false;
  assert.equal(await authorized(), false);
  assert.equal(browserReads, 2);
  assert.equal(workspaceReads, 2);
  browserActive = true;
  assert.equal(await authorized(), true);
  workspaceActive = false;
  assert.equal(await authorized(), false);
  assert.equal(workspaceReads, 4);
  assert.equal(nowMs, 1_000);
});

test('positive TTL caching permits a revoked grant before cache expiration (regression control)', async () => {
  const sessionId = 'native-session';
  const userId = 'renter';
  let nowMs = 1_000;
  let active = true;
  const authorized = createGatewayChannelLeaseGuard({
    sessionId,
    userId,
    cacheMs: 100,
    now: () => nowMs,
    readBrowser: async () => active ? JSON.stringify({ sessionId, userId }) : null,
    readWorkspace: async () => active
      ? { renterId: userId, expiresAt: new Date(60_000) }
      : null,
  });
  assert.equal(await authorized(), true);
  active = false;
  nowMs += 1;
  // Reproduces the old 100 ms positive-cache behavior for comparison.
  assert.equal(await authorized(), true);
  nowMs += 100;
  assert.equal(await authorized(), false);
});

test('zero-cache native channel fails closed after Redis/DB corruption or loss', async () => {
  const sessionId = 'native-session';
  const userId = 'renter';
  let browser: string | null = JSON.stringify({ sessionId, userId });
  let workspace: { renterId: string; expiresAt: Date } | null = {
    renterId: userId,
    expiresAt: new Date(60_000),
  };
  const authorized = createGatewayChannelLeaseGuard({
    sessionId,
    userId,
    cacheMs: 0,
    now: () => 1_000,
    readBrowser: async () => browser,
    readWorkspace: async () => workspace,
  });
  assert.equal(await authorized(), true);

  browser = '{malformed json';
  assert.equal(await authorized(), false, 'must not reuse positive grant after malformed browser lease');
  browser = JSON.stringify({ sessionId, userId });
  workspace = null;
  assert.equal(await authorized(), false, 'missing workspace grant must immediately deny');
  workspace = { renterId: 'other-user', expiresAt: new Date(60_000) };
  assert.equal(await authorized(), false, 'renter identity change must immediately deny');
  workspace = { renterId: userId, expiresAt: new Date(1_000) };
  assert.equal(await authorized(), false, 'expired workspace must immediately deny');

  workspace = { renterId: userId, expiresAt: new Date(60_000) };
  assert.equal(await authorized(), true, 'a fresh valid server grant can pass the next fresh check');
});

test('concurrent native checks share only an in-flight read, never a completed positive cache', async () => {
  const sessionId = 'native-session';
  const userId = 'renter';
  const raw = JSON.stringify({ sessionId, userId });
  let resolveBrowser: ((value: string | null) => void) | undefined;
  let browserReads = 0;
  let workspaceReads = 0;
  let workspaceActive = true;
  const authorized = createGatewayChannelLeaseGuard({
    sessionId,
    userId,
    cacheMs: 0,
    now: () => 1_000,
    readBrowser: () => {
      browserReads++;
      return new Promise<string | null>((resolve) => { resolveBrowser = resolve; });
    },
    readWorkspace: async () => {
      workspaceReads++;
      return workspaceActive ? { renterId: userId, expiresAt: new Date(60_000) } : null;
    },
  });
  const inFlight = Array.from({ length: 8 }, () => authorized());
  assert.equal(browserReads, 1, 'one pending network read may be shared among concurrent requests');
  assert.equal(workspaceReads, 1);
  assert.ok(resolveBrowser);
  resolveBrowser(raw);
  assert.deepEqual(await Promise.all(inFlight), Array(8).fill(true));

  workspaceActive = false;
  const next = authorized();
  assert.equal(browserReads, 2, 'next check must not reuse previous completed grant');
  assert.ok(resolveBrowser);
  resolveBrowser(raw);
  assert.equal(await next, false, 'revocation must be checked after coalesced request settled');
  assert.equal(workspaceReads, 2);
});

test('native grant is revoked if the server reassigns the channel machine or runtime backend', async () => {
  const sessionId = 'native-session';
  const userId = 'renter';
  const browser = JSON.stringify({ sessionId, userId });
  let machineId = 'pc1';
  let runtimeBackend = 'WINDOWS_NATIVE';
  const authorized = createGatewayChannelLeaseGuard({
    sessionId,
    userId,
    expectedMachineId: 'pc1',
    expectedRuntimeBackend: 'WINDOWS_NATIVE',
    cacheMs: 0,
    now: () => 1_000,
    readBrowser: async () => browser,
    readWorkspace: async () => ({
      renterId: userId,
      expiresAt: new Date(60_000),
      machineId,
      runtimeBackend,
    }),
  });

  assert.equal(await authorized(), true);
  machineId = 'pc2';
  assert.equal(await authorized(), false, 'old WebSocket cannot follow a reassigned machine');
  machineId = 'pc1';
  runtimeBackend = 'DOCKER';
  assert.equal(await authorized(), false, 'old native WebSocket cannot change its runtime backend');
  runtimeBackend = 'WINDOWS_NATIVE';
  assert.equal(await authorized(), true);
});
