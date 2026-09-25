import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('owner mining resource view exposes telemetry snapshot and freshness timestamp', async () => {
  const source = await readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');
  assert.match(source, /r\."lastTelemetry"/);
  assert.match(source, /r\."lastTelemetryAt"/);
  assert.match(source, /lastTelemetry:\s*Prisma\.JsonValue \| null/);
  assert.match(source, /lastTelemetryAt:\s*Date \| null/);
});

test('owner mining resource view still does not select pool secret references', async () => {
  const source = await readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const listOwnerResources');
  const end = source.indexOf('export const registerMiningRoutes', start);
  const view = source.slice(start, end);
  assert.doesNotMatch(view, /ownerPoolSecretRef/);
});