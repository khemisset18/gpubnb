import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { verifyAgentRequestV2 } from '../src/security.js';

class FakeRedis {
  private readonly keys = new Set<string>();

  async set(key: string, _value: string, _ex: string, _ttl: number, mode: string) {
    assert.equal(mode, 'NX');
    if (this.keys.has(key)) return null;
    this.keys.add(key);
    return 'OK';
  }
}

function signedRequest(body: Uint8Array) {
  const keyPair = nacl.sign.keyPair();
  const machineId = 'machine-test';
  const timestamp = String(Date.now());
  const nonce = 'nonce_0123456789abcdef';
  const bodySha256 = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = `POST|/agent/heartbeat|${machineId}|${timestamp}|${nonce}|${bodySha256}`;
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(canonical), keyPair.secretKey));
  return {
    machineId,
    publicKey: bs58.encode(keyPair.publicKey),
    bodySha256,
    headers: { timestamp, nonce, bodySha256, signature, version: '2' },
  };
}

test('accepts a valid v2 signature exactly once', async () => {
  const redis = new FakeRedis();
  const body = Buffer.from('{"machineId":"machine-test","counter":1}');
  const signed = signedRequest(body);

  assert.equal(await verifyAgentRequestV2(
    redis as never,
    signed.machineId,
    signed.publicKey,
    'POST',
    '/agent/heartbeat',
    body,
    signed.headers,
  ), true);

  assert.equal(await verifyAgentRequestV2(
    redis as never,
    signed.machineId,
    signed.publicKey,
    'POST',
    '/agent/heartbeat',
    body,
    signed.headers,
  ), false);
});

test('rejects any body alteration', async () => {
  const redis = new FakeRedis();
  const body = Buffer.from('{"machineId":"machine-test","counter":1}');
  const signed = signedRequest(body);
  const altered = Buffer.from('{"machineId":"machine-test","counter":2}');

  assert.equal(await verifyAgentRequestV2(
    redis as never,
    signed.machineId,
    signed.publicKey,
    'POST',
    '/agent/heartbeat',
    altered,
    signed.headers,
  ), false);
});

test('rejects an invalid signature and an expired timestamp', async () => {
  const body = Buffer.from('{"machineId":"machine-test","counter":1}');
  const signed = signedRequest(body);

  assert.equal(await verifyAgentRequestV2(
    new FakeRedis() as never,
    signed.machineId,
    signed.publicKey,
    'POST',
    '/agent/heartbeat',
    body,
    { ...signed.headers, signature: `${signed.headers.signature}x` },
  ), false);

  assert.equal(await verifyAgentRequestV2(
    new FakeRedis() as never,
    signed.machineId,
    signed.publicKey,
    'POST',
    '/agent/heartbeat',
    body,
    { ...signed.headers, timestamp: String(Date.now() - 31_000) },
  ), false);
});

test('rejects a signature presented for another machine', async () => {
  const body = Buffer.from('{"machineId":"machine-test","counter":1}');
  const signed = signedRequest(body);

  assert.equal(await verifyAgentRequestV2(
    new FakeRedis() as never,
    'different-machine',
    signed.publicKey,
    'POST',
    '/agent/heartbeat',
    body,
    signed.headers,
  ), false);
});

test('rejects malformed nonces and unsupported versions', async () => {
  const body = Buffer.from('{}');
  const signed = signedRequest(body);

  assert.equal(await verifyAgentRequestV2(
    new FakeRedis() as never,
    signed.machineId,
    signed.publicKey,
    'POST',
    '/agent/heartbeat',
    body,
    { ...signed.headers, nonce: '../unsafe' },
  ), false);

  assert.equal(await verifyAgentRequestV2(
    new FakeRedis() as never,
    signed.machineId,
    signed.publicKey,
    'POST',
    '/agent/heartbeat',
    body,
    { ...signed.headers, version: '1' },
  ), false);
});
