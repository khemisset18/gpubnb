import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { issueDataPlaneAuthority } from '../src/data-plane-authority.js';

const outDir = resolve(process.argv[2] ?? '.');
const edgeId = 'edge_e2e_1';
const sessionId = 'session_e2e_reconnect';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicJwk = publicKey.export({ format: 'jwk' });
if (publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || typeof publicJwk.x !== 'string') {
  throw new Error('unexpected Ed25519 public JWK shape');
}
const rawPublic = Buffer.from(publicJwk.x, 'base64url').toString('hex');
if (rawPublic.length !== 64) throw new Error('unexpected Ed25519 public key length');
writeFileSync(resolve(outDir, 'authority-public.hex'), `${rawPublic}\n`, { mode: 0o600 });

const nonces = new Set<string>();
for (let index = 1; index <= 3; index += 1) {
  const envelope = issueDataPlaneAuthority({
    edgeId,
    sessionId,
    machineId: 'machine_e2e_1',
    bookingId: 'booking_e2e_1',
    renterUserId: 'user_e2e_1',
    privateKey,
    ttlMs: 60_000,
  });
  if (nonces.has(envelope.binding.nonce)) throw new Error('authority nonce collision');
  nonces.add(envelope.binding.nonce);
  writeFileSync(resolve(outDir, `authority-${index}.json`), JSON.stringify(envelope), { mode: 0o600 });
}
