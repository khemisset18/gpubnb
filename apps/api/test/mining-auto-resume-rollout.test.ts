import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('rental cleanup never schedules mining auto-resume when Gateway rollout is disabled', async () => {
  const source = await readFile(new URL('../src/rental-resource-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/mining/:machineId/rental-authority/:sessionId/release'");
  assert.ok(start >= 0, 'rental release route missing');
  const body = source.slice(start);

  assert.match(body, /commandDispatchConfigFromEnv\(\)/);
  assert.match(body, /commandGatewayAssigned\(machineId, commandDispatchConfigFromEnv\(\)\)/);
  assert.match(body, /if \(!remoteControlEnabled\)/);
  assert.match(body, /autoResume\.skipped\.push\(resourceId\)/);
  assert.ok(
    body.indexOf('if (!remoteControlEnabled)')
      < body.indexOf('requestSystemMiningAutoResume(db, redis, {'),
    'rollout gate must run before auto-resume can create a durable START command',
  );
});
