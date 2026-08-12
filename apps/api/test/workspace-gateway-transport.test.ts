import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserPendingBudget,
  WS_BROWSER_PENDING_MAX_BYTES,
  WS_BROWSER_PENDING_MAX_ITEMS,
  isStrictBase64Payload,
  rewriteWorkspaceLocation,
  websocketDataToBuffer,
} from '../src/workspace-gateway-transport.js';

test('browser pending budget is bounded by both items and bytes', () => {
  const budget = new BrowserPendingBudget();
  for (let index = 0; index < WS_BROWSER_PENDING_MAX_ITEMS; index += 1) {
    assert.equal(budget.tryAcquire(1), true);
  }
  assert.equal(budget.tryAcquire(1), false);
  for (let index = 0; index < WS_BROWSER_PENDING_MAX_ITEMS; index += 1) {
    budget.release(1);
  }
  assert.deepEqual(budget.snapshot(), {items: 0, bytes: 0});

  assert.equal(budget.tryAcquire(WS_BROWSER_PENDING_MAX_BYTES), true);
  assert.equal(budget.tryAcquire(1), false);
  budget.release(WS_BROWSER_PENDING_MAX_BYTES);
  assert.deepEqual(budget.snapshot(), {items: 0, bytes: 0});
});

test('strict base64 rejects malformed or decoded-oversize frames', () => {
  assert.equal(isStrictBase64Payload('eA==', 16, 1), true);
  assert.equal(isStrictBase64Payload('%%%=', 16, 16), false);
  assert.equal(isStrictBase64Payload('eA=', 16, 16), false);
  assert.equal(isStrictBase64Payload('eHk=', 16, 1), false);
  assert.equal(isStrictBase64Payload(123, 16, 16), false);
});

test('workspace absolute redirects stay inside the authenticated gateway prefix', () => {
  assert.equal(
    rewriteWorkspaceLocation('/stable-abc/static/workbench.js', 'session-1'),
    '/workspace-gateway/session-1/stable-abc/static/workbench.js',
  );
  assert.equal(
    rewriteWorkspaceLocation('/workspace-gateway/session-1/', 'session-1'),
    '/workspace-gateway/session-1/',
  );
  assert.equal(rewriteWorkspaceLocation('https://example.com/x', 'session-1'), 'https://example.com/x');
  assert.equal(rewriteWorkspaceLocation('//cdn.example.com/x', 'session-1'), '//cdn.example.com/x');
  assert.equal(rewriteWorkspaceLocation('relative/path', 'session-1'), 'relative/path');
});

test('websocket data normalization preserves bytes and fragmented buffers', () => {
  const first = Buffer.from([0x00, 0x9b, 0xff]);
  assert.deepEqual(websocketDataToBuffer(first), first);
  assert.deepEqual(websocketDataToBuffer([Buffer.from('a'), Buffer.from('b')]), Buffer.from('ab'));
  assert.deepEqual(websocketDataToBuffer(Uint8Array.from([1, 2, 3]).buffer), Buffer.from([1, 2, 3]));
});
