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
