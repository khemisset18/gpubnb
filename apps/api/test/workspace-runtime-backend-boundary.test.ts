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
});

test('the generic browser gateway is structurally container-only', () => {
  assert.match(gateway, /WorkspaceRuntimeBackend\.CONTAINER/);
  const backendGuards = gateway.match(/runtimeBackend:WorkspaceRuntimeBackend\.CONTAINER/g) ?? [];
  assert.ok(
    backendGuards.length >= 6,
    'browser access, activation, desired, registration, usage and stop must all be backend-fenced',
  );
});

test('cleanup cannot quarantine an unrelated or Windows-native session', () => {
  const stoppedRoute = gateway.indexOf("app.post('/agent/workspace-gateway/:sessionId/stopped'");
  assert.ok(stoppedRoute >= 0);
  const route = gateway.slice(stoppedRoute, gateway.indexOf("\n  });", stoppedRoute) + 5);
  const lookup = route.indexOf('runtimeBackend:WorkspaceRuntimeBackend.CONTAINER');
  const quarantine = route.indexOf('if(body.cleaned!==true)');
  assert.ok(lookup >= 0, 'stopped route must resolve an exact container-owned session first');
  assert.ok(quarantine > lookup, 'cleanup failure must not quarantine before backend/session authorization');
});
