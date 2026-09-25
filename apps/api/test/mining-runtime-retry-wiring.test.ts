import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function compact(value: string): string {
  return value.replace(/\s+/g, '');
}

test('mining runtime verifies the agent before entering the retried transaction', async () => {
  const source = await readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/internal/mining/runtime-events'");
  assert.ok(start >= 0);
  const body = source.slice(start);
  const verifyIndex = body.indexOf('verifyAgentRequestV2');
  const retryIndex = body.indexOf('runBookingTransaction(db');

  assert.ok(verifyIndex >= 0 && retryIndex > verifyIndex);
  const retriedBody = body.slice(retryIndex);
  assert.doesNotMatch(retriedBody, /verifyAgentRequestV2/);
  assert.doesNotMatch(retriedBody, /recordSecurityFailure\(redis/);
});

test('mining runtime retry is bounded and protected by the event idempotency key', async () => {
  const source = await readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/internal/mining/runtime-events'");
  assert.ok(start >= 0);
  const body = compact(source.slice(start));

  assert.match(body, /runBookingTransaction\(db,async\(tx\)=>/);
  assert.match(body, /WHEREe\."idempotencyKey"=\$\{event\.idempotencyKey\}/);
  assert.match(body, /if\(existing\.length\)/);
  assert.match(body, /returnfalse/);
  assert.match(body, /isolationLevel:Prisma\.TransactionIsolationLevel\.Serializable/);
  assert.match(body, /maxWait:5_000/);
  assert.match(body, /timeout:10_000/);
});


test('heartbeat telemetry cannot enter the runtime-event state transition authority', async () => {
  const source = await readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');
  const schemaStart = source.indexOf('const runtimeEventSchema = z.object({');
  const schemaEnd = source.indexOf('type MiningResourceRow', schemaStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart);
  const schema = source.slice(schemaStart, schemaEnd);
  assert.doesNotMatch(schema, /'HEARTBEAT'/);

  const routeStart = source.indexOf("app.post('/internal/mining/runtime-events'");
  assert.ok(routeStart >= 0);
  const route = source.slice(routeStart);
  assert.match(route, /SET "runtimeState" = \$\{event\.stateAfter\}/);
});

test('signed heartbeat telemetry stays on the observation-only sync path', async () => {
  const server = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /syncMiningHeartbeatTelemetry\(tx,m\.id,b\.telemetry\.miningResources\)/);

  const sync = await readFile(new URL('../src/mining-heartbeat-telemetry.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(sync, /"runtimeState"\s*=/);
  assert.match(sync, /"lastTelemetry"/);
  assert.match(sync, /"lastTelemetryAt"/);
});


test('agent runtime endpoint cannot forge server-owned lifecycle or rental transitions', async () => {
  const source = await readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');
  const schemaStart = source.indexOf('const runtimeEventSchema = z.discriminatedUnion');
  const schemaEnd = source.indexOf('type MiningResourceRow', schemaStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart);
  const schema = source.slice(schemaStart, schemaEnd);

  assert.match(schema, /eventType: z\.literal\('QUARANTINED'\)/);
  assert.match(schema, /stateAfter: z\.literal\('QUARANTINED'\)/);
  assert.match(schema, /eventType: z\.literal\('EMERGENCY_STOPPED'\)/);
  assert.match(schema, /stateAfter: z\.literal\('EMERGENCY_STOPPED'\)/);
  for (const serverOwned of [
    'START_REQUESTED',
    'STARTED',
    'START_FAILED',
    'STOP_REQUESTED',
    'STOP_VERIFIED',
    'STOP_FAILED',
    'RENTAL_PREEMPTED',
    'RENTAL_RELEASED',
    'CLEANUP_VERIFIED',
    'AUTO_RESUME_REQUESTED',
  ]) {
    assert.doesNotMatch(schema, new RegExp(`'${serverOwned}'`));
  }
  assert.match(schema, /reservationId: z\.null\(\)\.optional\(\)/);
});

test('agent safety events preserve rental ownership and require current-state precondition', async () => {
  const source = await readFile(new URL('../src/mining-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/internal/mining/runtime-events'");
  assert.ok(start >= 0);
  const body = source.slice(start);

  assert.match(body, /event\.stateBefore !== current\.runtimeState/);
  assert.match(body, /mining_runtime_state_precondition_failed/);
  assert.match(body, /"quarantined" = true/);
  assert.doesNotMatch(body, /SET[\s\S]{0,500}"activeRentalId"\s*=/);
});
