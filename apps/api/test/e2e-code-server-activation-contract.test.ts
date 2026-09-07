import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

async function e2eSource(): Promise<string> {
  return readFile(path.join(repoRoot, 'e2e/run.cjs'), 'utf8');
}

test('real E2E requires upstream code-server frames on both VS Code channels', async () => {
  const source = await e2eSource();
  assert.match(source, /proveCodeServerChannel\('Management'\)/);
  assert.match(source, /proveCodeServerChannel\('ExtensionHost'\)/);
  assert.match(source, /ws\.on\('message'/);
  assert.match(source, /upstreamFrameSeen = true/);
  assert.match(source, /current\?\.status === 'ACTIVE' && current\.workspaceActivatedAt/);
});

test('real E2E requires clean COMPLETED termination after activation', async () => {
  const source = await e2eSource();
  assert.match(source, /session reaches COMPLETED after genuine interactive activation/);
  assert.match(source, /s\.status === 'COMPLETED'/);
  assert.match(source, /\['FAILED', 'TIMED_OUT', 'CANCELLED'\]\.includes\(s\.status\)/);
  assert.doesNotMatch(source, /ws\.on\('open', \(\) => \{ clearTimeout\(timer\); setTimeout\(\(\) => ws\.close\(\), 1000\); \}\)/);
});
