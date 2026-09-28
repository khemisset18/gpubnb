import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('../prisma/migrations/20260919135000_add_workspace_runtime_backend/migration.sql', import.meta.url),
  'utf8',
);
const gateway = fs.readFileSync(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');

test('workspace sessions require an explicit persisted runtime-family identity', () => {
  assert.match(schema, /enum WorkspaceRuntimeBackend \{\s*CONTAINER\s*WINDOWS_NATIVE\s*\}/);
  assert.match(schema, /runtimeBackend WorkspaceRuntimeBackend\n/);
  assert.doesNotMatch(schema, /runtimeBackend WorkspaceRuntimeBackend @default/);
  assert.match(schema, /@@index\(\[machineId, runtimeBackend, status\]\)/);
  assert.match(migration, /CREATE TYPE "WorkspaceRuntimeBackend" AS ENUM \('CONTAINER', 'WINDOWS_NATIVE'\)/);
  assert.match(migration, /UPDATE "WorkspaceSession"[\s\S]*SET "runtimeBackend" = 'CONTAINER'/);
  assert.match(migration, /ALTER COLUMN "runtimeBackend" SET NOT NULL/);
  assert.doesNotMatch(migration, /DEFAULT 'CONTAINER'/);
  assert.match(migration, /WorkspaceSession_runtime_backend_immutable/);
  assert.match(migration, /BEFORE UPDATE OF "runtimeBackend" ON "WorkspaceSession"/);
  assert.match(migration, /workspace runtime backend is immutable/);
});

test('browser gateway admits only the explicit container/native runtime allowlist', () => {
  assert.match(gateway, /gatewayRuntimeBackends\(\)/);
  assert.match(gateway, /isWindowsNativeRuntime\(row\.runtimeBackend\)/);
  assert.match(gateway, /windows_native_websocket_only/);
  assert.match(gateway, /windowsNativeUpgradeAllowed\(row\.runtimeBackend/);
  assert.match(gateway, /browserGatewayFrameAllowed\(row\.runtimeBackend/);
});

test('cleanup authorizes an exact session and an explicit runtime backend before quarantine', () => {
  const stoppedRoute = gateway.indexOf("app.post('/agent/workspace-gateway/:sessionId/stopped'");
  assert.ok(stoppedRoute >= 0);
  const route = gateway.slice(stoppedRoute, gateway.indexOf("\n  });", stoppedRoute) + 5);
  const lookup = route.indexOf('where:{id:sessionId,machineId,runtimeBackend:{in:gatewayRuntimeBackends()}');
  const quarantine = route.indexOf('if(body.cleaned!==true)');
  assert.ok(lookup >= 0, 'stopped route must resolve exact session, machine and approved backend first');
  assert.ok(quarantine > lookup, 'cleanup failure must not quarantine before backend/session authorization');
});
