import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { WorkspaceRuntimeBackend } from '@prisma/client';
import { browserGatewayFrameAllowed } from '../src/windows-native-gateway-policy.js';
import { websocketDataToBuffer, websocketMessageIsBinary } from '../src/workspace-gateway-transport.js';

test('locked ws wire transport preserves native binary input and rejects same-size text', {timeout: 5000}, async () => {
  const server = new WebSocket.Server({host: '127.0.0.1', port: 0});
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  let peer: WebSocket | undefined;
  try {
    [peer] = await connected as [WebSocket];
    await once(client, 'open');
    for (const binary of [true, true, false, true]) {
      const incoming = once(peer, 'message');
      client.send(binary ? Buffer.alloc(32, 0x41) : 'A'.repeat(32), {binary});
      const [data, metadata] = await incoming;
      const bytes = websocketDataToBuffer(data);
      assert.equal(bytes.length, 32);
      // Regression: ws 7 does not supply metadata. The old gateway passed
      // undefined to its binary-only policy and rejected genuine input.
      assert.equal(websocketMessageIsBinary(data, metadata), binary);
      assert.equal(browserGatewayFrameAllowed(WorkspaceRuntimeBackend.WINDOWS_NATIVE,
        websocketMessageIsBinary(data, metadata), bytes.length), binary);
    }
    assert.equal(peer.readyState, WebSocket.OPEN);
  } finally {
    client.terminate();
    peer?.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('explicit opcode metadata takes precedence over Buffer representation', () => {
  const data = Buffer.alloc(32);
  assert.equal(websocketMessageIsBinary(data, false), false);
  assert.equal(websocketMessageIsBinary(data, true), true);
  assert.equal(websocketMessageIsBinary('A'.repeat(32)), false);
});
