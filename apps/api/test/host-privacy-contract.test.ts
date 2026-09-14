import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../../', import.meta.url);

async function read(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('privacy contract pins renter isolation and support-report minimization', async () => {
  const [contract, runtimeArchitecture, supportReport] = await Promise.all([
    read('docs/HOST_PRIVACY_AND_ISOLATION.md'),
    read('docs/WORKSPACE_RUNTIME_ARCHITECTURE.md'),
    read('apps/host-desktop/src/support-report.ts'),
  ]);

  for (const requirement of [
    'no renter-controlled Host/LAN target',
    'no Docker socket in renter Workspaces',
    'no owner filesystem bind mount into renter Workspaces',
    'per-session runtime/storage/network identity and verified cleanup',
    'booking/session-scoped access authority',
    'support-report allowlist with secret/path/log exclusion',
  ]) {
    assert.match(contract, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  assert.match(runtimeArchitecture, /never mounts the Docker socket/i);
  assert.match(runtimeArchitecture, /fresh per-session internal Docker network/i);
  assert.match(runtimeArchitecture, /fresh per-session volume/i);
  assert.match(runtimeArchitecture, /cannot supply an arbitrary upstream host\/port/i);

  // The support report must remain a curated allowlist and must not grow into
  // a raw log/config/environment dump without an explicit security review.
  assert.doesNotMatch(supportReport, /process\.env/);
  assert.doesNotMatch(supportReport, /agent\.key/);
  assert.doesNotMatch(supportReport, /config\.json/);
  assert.doesNotMatch(supportReport, /readFileSync|readFile\(/);
});

test('privacy contract does not overclaim VM isolation', async () => {
  const contract = await read('docs/HOST_PRIVACY_AND_ISOLATION.md');
  assert.match(contract, /must not be described as having stronger isolation/i);
  assert.match(contract, /must not claim VM-level isolation/i);
});
