import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closeDataPlaneConnection,
  createDataPlaneConnection,
  interactiveLatencyMs,
  markServiceReady,
  markStreamClosed,
  markStreamReady,
  markTunnelReady,
  recordFallback,
  recordReconnect,
} from '../src/data-plane-connection-state.js';

test('HTML/service/tunnel readiness can never claim an interactive Developer session', () => {
  let state = createDataPlaneConnection('EDGE_QUIC', 1000);
  state = markServiceReady(state, 1100);
  assert.equal(state.phase, 'SERVICE_READY');
  state = markTunnelReady(state, 1200);
  assert.equal(state.phase, 'TUNNEL_READY');
  assert.equal(interactiveLatencyMs(state), null);
});

test('Management alone is not interactive; ExtensionHost completes the proof', () => {
  let state = createDataPlaneConnection('EDGE_QUIC', 1000);
  state = markServiceReady(state, 1100);
  state = markTunnelReady(state, 1200);
  state = markStreamReady(state, 'VSCODE_MANAGEMENT', 1300);
  assert.equal(state.phase, 'MANAGEMENT_READY');
  assert.equal(state.interactiveAtMs, undefined);

  state = markStreamReady(state, 'VSCODE_EXTENSION_HOST', 1450);
  assert.equal(state.phase, 'INTERACTIVE');
  assert.equal(state.interactiveAtMs, 1450);
  assert.equal(interactiveLatencyMs(state), 350);
});

test('ExtensionHost arriving before Management is valid but still not interactive', () => {
  let state = createDataPlaneConnection('EDGE_QUIC', 1000);
  state = markServiceReady(state, 1100);
  state = markTunnelReady(state, 1200);
  state = markStreamReady(state, 'VSCODE_EXTENSION_HOST', 1250);
  assert.equal(state.phase, 'EXTENSION_HOST_READY');
  state = markStreamReady(state, 'VSCODE_MANAGEMENT', 1400);
  assert.equal(state.phase, 'INTERACTIVE');
});

test('losing a critical VS Code stream after INTERACTIVE becomes DEGRADED', () => {
  let state = createDataPlaneConnection('EDGE_QUIC', 1000);
  state = markServiceReady(state, 1100);
  state = markTunnelReady(state, 1200);
  state = markStreamReady(state, 'VSCODE_MANAGEMENT', 1300);
  state = markStreamReady(state, 'VSCODE_EXTENSION_HOST', 1400);
  state = markStreamClosed(state, 'VSCODE_EXTENSION_HOST', 1700);
  assert.equal(state.phase, 'DEGRADED');
  assert.equal(state.degradedAtMs, 1700);
});

test('fallback and reconnect are explicit, bounded events', () => {
  let state = createDataPlaneConnection('DIRECT_QUIC', 1000);
  state = markServiceReady(state, 1100);
  state = markTunnelReady(state, 1200);
  state = recordReconnect(state);
  state = recordFallback(state, 'EDGE_QUIC');
  assert.equal(state.reconnects, 1);
  assert.equal(state.fallbacks, 1);
  assert.equal(state.transport, 'EDGE_QUIC');
  assert.throws(() => recordFallback(state, 'EDGE_QUIC'), /same_transport/);
});

test('event order is fail-closed and closed sessions cannot be resurrected', () => {
  let state = createDataPlaneConnection('EDGE_QUIC', 1000);
  assert.throws(() => markTunnelReady(state, 1100), /service_not_ready/);
  state = markServiceReady(state, 1100);
  assert.throws(() => markStreamReady(state, 'VSCODE_MANAGEMENT', 1200), /tunnel_not_ready/);
  state = closeDataPlaneConnection(state, 1300);
  assert.equal(state.phase, 'CLOSED');
  assert.throws(() => recordReconnect(state), /connection_closed/);
});
