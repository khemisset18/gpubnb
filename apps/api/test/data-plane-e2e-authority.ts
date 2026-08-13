import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { issueDataPlaneAuthority } from '../src/data-plane-authority.js';

const outDir = resolve(process.argv[2] ?? '.');
const edgeId = 'edge_e2e_1';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const rawPublic = Buffer.from(spki).subarray(-32).toString('hex');
writeFileSync(resolve(outDir, 'authority-public.hex'), `${rawPublic}\n`, { mode: 0o600 });

for (let index = 1; index <= 3; index += 1) {
  const envelope = issueDataPlaneAuthority({
    edgeId,
    sessionId: `session_e2e_${index}`,
    machineId: 'machine_e2e_1',
    bookingId: 'booking_e2e_1',
    renterUserId: 'user_e2e_1',
    privateKey,
    ttlMs: 60_000,
  });
  writeFileSync(resolve(outDir, `authority-${index}.json`), JSON.stringify(envelope), { mode: 0o600 });
}
