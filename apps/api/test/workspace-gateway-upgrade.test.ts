import test from 'node:test';
import assert from 'node:assert/strict';
import { websocketUpgradeRejection } from '../src/workspace-gateway.js';

test('websocket rejection is a complete non-cacheable HTTP response',()=>{
  const response=websocketUpgradeRejection(401,'workspace_auth_required').toString('utf8');
  assert.match(response,/^HTTP\/1\.1 401 Unauthorized\r\n/);
  assert.match(response,/Connection: close\r\n/);
  assert.match(response,/Cache-Control: no-store\r\n/);
  assert.match(response,/Content-Type: application\/json; charset=utf-8\r\n/);
  assert.match(response,/Content-Length: \d+\r\n\r\n/);
  assert.match(response,/\{"error":"workspace_auth_required"\}$/);
});

test('websocket rejection never exposes internal details beyond the stable error code',()=>{
  const response=websocketUpgradeRejection(500,'workspace_gateway_upgrade_failed').toString('utf8');
  assert.match(response,/HTTP\/1\.1 500 Internal Server Error/);
  assert.doesNotMatch(response,/stack|redis|cookie|token|sessionSecret/i);
});
