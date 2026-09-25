import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourcePromise = readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');

function routeSlice(source: string, marker: string, nextMarker: string): string {
  const start = source.indexOf(marker);
  const end = source.indexOf(nextMarker, start + marker.length);
  assert.ok(start >= 0 && end > start, `route slice missing: ${marker}`);
  return source.slice(start, end);
}

test('owner START route authenticates then delegates all runtime authority to mining-command-service', async () => {
  const source = await sourcePromise;
  const body = routeSlice(
    source,
    "app.post('/machines/:machineId/mining-resources/:resourceId/start'",
    "app.post('/machines/:machineId/mining-resources/:resourceId/stop'",
  );
  assert.match(body, /requireSession\(request, reply, redis\)/);
  assert.match(body, /requestMiningStart\(db, redis, \{/);
  assert.match(body, /ownerId: session\.userId/);
  assert.match(body, /reply\.code\(202\)/);
  assert.doesNotMatch(body, /request\.body/);
  assert.doesNotMatch(body, /walletAddress|ownerPoolEndpoint|hardwareUuid|runtimeGeneration|fencingToken/);
});

test('owner STOP route is idempotent and accepts no browser-supplied runtime authority', async () => {
  const source = await sourcePromise;
  const body = routeSlice(
    source,
    "app.post('/machines/:machineId/mining-resources/:resourceId/stop'",
    "app.post('/internal/mining/runtime-events'",
  );
  assert.match(body, /requireSession\(request, reply, redis\)/);
  assert.match(body, /requestMiningStop\(db, redis, \{/);
  assert.match(body, /reply\.code\(result\.alreadySatisfied \? 200 : 202\)/);
  assert.doesNotMatch(body, /request\.body/);
  assert.doesNotMatch(body, /walletAddress|ownerPoolEndpoint|hardwareUuid|runtimeGeneration|fencingToken/);
});