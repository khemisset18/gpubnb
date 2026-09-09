import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function configDefault(source: string, key: string): number {
  const match = new RegExp(`${key}:\\s*z\\.coerce\\.number\\(\\)\\.int\\(\\).*?\\.default\\((\\d+)\\)`).exec(source);
  assert.ok(match, `missing numeric default for ${key}`);
  return Number(match[1]);
}

test('workspace access freshness never exceeds the API offline threshold', async () => {
  const config = await readFile(new URL('../src/config.ts', import.meta.url), 'utf8');
  const accessMaxAge = configDefault(config, 'WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS');
  const offlineAfter = configDefault(config, 'HEARTBEAT_OFFLINE_SECONDS');

  assert.equal(accessMaxAge, 55);
  assert.equal(offlineAfter, 300);
  assert.ok(offlineAfter >= accessMaxAge);
});

test('Render preserves the same 300 second heartbeat offline budget for web and worker', async () => {
  const render = await readFile(new URL('../../../render.yaml', import.meta.url), 'utf8');
  const values = [...render.matchAll(/- key: HEARTBEAT_OFFLINE_SECONDS\s+value: (\d+)/g)].map((match) => Number(match[1]));

  assert.deepEqual(values, [300, 300]);
  assert.ok(values.every((value) => value >= 55));
});
