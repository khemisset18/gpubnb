import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKSPACE_RECONNECT_GRACE_SECONDS,
  parseWorkspaceReconnectState,
  provisionalReconnectEndsAt,
  resumedReconnectEndsAt,
} from '../src/workspace-reconnect-grace.js';

test('reconnect grace is exactly ten minutes', () => {
  assert.equal(WORKSPACE_RECONNECT_GRACE_SECONDS, 600);
});

test('provisional reconnect hold reserves at most the ten-minute grace window', () => {
  const original = new Date('2026-09-14T20:00:00.000Z');
  assert.equal(
    provisionalReconnectEndsAt(original).toISOString(),
    '2026-09-14T20:10:00.000Z',
  );
});

test('successful reconnect returns only the actual lost time, not the full grace', () => {
  const original = new Date('2026-09-14T20:00:00.000Z');
  const interrupted = new Date('2026-09-14T19:30:00.000Z');
  const resumed = new Date('2026-09-14T19:32:37.000Z');
  assert.equal(
    resumedReconnectEndsAt(original, interrupted, resumed).toISOString(),
    '2026-09-14T20:02:37.000Z',
  );
});

test('reconnect metadata parser fails closed on malformed or inconsistent state', () => {
  assert.equal(parseWorkspaceReconnectState(null), null);
  assert.equal(parseWorkspaceReconnectState({ reconnectGrace: {} }), null);
  assert.equal(parseWorkspaceReconnectState({ reconnectGrace: {
    protocolVersion: 99,
    interruptedAt: '2026-09-14T19:30:00.000Z',
    reconnectDeadlineAt: '2026-09-14T19:40:00.000Z',
    originalEndsAt: '2026-09-14T20:00:00.000Z',
  } }), null);
  assert.equal(parseWorkspaceReconnectState({ reconnectGrace: {
    protocolVersion: 1,
    interruptedAt: '2026-09-14T19:40:00.000Z',
    reconnectDeadlineAt: '2026-09-14T19:30:00.000Z',
    originalEndsAt: '2026-09-14T20:00:00.000Z',
  } }), null);
});

test('reconnect metadata parser preserves trusted interruption/deadline/end timestamps', () => {
  const state = parseWorkspaceReconnectState({
    gatewayPath: '/workspace-gateway/session',
    reconnectGrace: {
      protocolVersion: 1,
      interruptedAt: '2026-09-14T19:30:00Z',
      reconnectDeadlineAt: '2026-09-14T19:40:00Z',
      originalEndsAt: '2026-09-14T20:00:00Z',
    },
  });
  assert.deepEqual(state, {
    protocolVersion: 1,
    interruptedAt: '2026-09-14T19:30:00.000Z',
    reconnectDeadlineAt: '2026-09-14T19:40:00.000Z',
    originalEndsAt: '2026-09-14T20:00:00.000Z',
  });
});
