import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(process.cwd(), '../..');

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

test('Windows standby changes only system sleep and never the display or power plan', async () => {
  const [powerGuard, windowsService] = await Promise.all([
    source('agent/gpubnb_agent/power_guard.py'),
    source('agent/gpubnb_agent/windows_service.py'),
  ]);

  assert.match(powerGuard, /ES_SYSTEM_REQUIRED\s*=\s*0x00000001/);
  assert.match(powerGuard, /ES_CONTINUOUS\s*=\s*0x80000000/);
  assert.doesNotMatch(powerGuard, /^\s*ES_DISPLAY_REQUIRED\s*=/m);
  assert.doesNotMatch(powerGuard, /\bpowercfg\b/i);
  assert.doesNotMatch(windowsService, /\bpowercfg\b/i);
  assert.match(windowsService, /name="gpubnb-host-power-guard"/);
});

test('power policy keeps quarantine recovery read-only without weakening rental authority', async () => {
  const routes = await source('apps/api/src/rental-resource-routes.ts');

  assert.match(routes, /app\.get\('\/agent\/host\/:machineId\/power-policy'/);
  assert.match(routes, /authenticateAgent\(db, redis, machineId, request, route, false\)/);
  assert.match(routes, /app\.get\('\/agent\/mining\/:machineId\/rental-authority'/);

  const relaxedCalls = routes.match(/authenticateAgent\([^\n;]*false\)/g) ?? [];
  assert.equal(
    relaxedCalls.length,
    1,
    'only the signed read-only power-policy route may relax moderationStatus=CLEAR',
  );
});

test('release compatibility defaults to observation and gates new allocation through UNAVAILABLE', async () => {
  const [policy, runtime, allocation] = await Promise.all([
    source('apps/api/src/release-compatibility-policy.ts'),
    source('apps/api/src/release-compatibility-runtime.ts'),
    source('apps/api/src/resource-allocation-service.ts'),
  ]);

  assert.match(policy, /GPUBNB_RELEASE_COMPATIBILITY_MODE\s*\?\?\s*'observe'/);
  assert.match(runtime, /mode === 'enforce' && !observation\.compatible/);
  assert.match(runtime, /operational:\s*MachineOperational\.UNAVAILABLE/);
  assert.match(allocation, /booking\.listing\.machine\.operational === MachineOperational\.UNAVAILABLE/);
});

test('compatibility observation can only be derived after an accepted heartbeat response', async () => {
  const runtime = await source('apps/api/src/release-compatibility-runtime.ts');

  assert.match(runtime, /request\.routeOptions\.url !== '\/agent\/heartbeat'/);
  assert.match(runtime, /reply\.statusCode >= 300/);
  assert.match(runtime, /observeSuccessfulHeartbeat\(app, db, redis, request, payload\)/);
});

test('pre-physical candidate keeps explicit fail-safe diagnostics for an old power-policy API', async () => {
  const powerGuard = await source('agent/gpubnb_agent/power_guard.py');

  assert.match(powerGuard, /HostPowerPolicyCompatibilityError/);
  assert.match(powerGuard, /api_missing_power_policy/);
  assert.match(powerGuard, /standbyReady/);
  assert.match(powerGuard, /deploy_power_policy_api_before_idle_standby_test/);
  assert.match(powerGuard, /host_power_policy_reason_inconsistent/);
});
