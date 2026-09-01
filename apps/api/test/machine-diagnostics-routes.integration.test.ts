import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { Transform } from 'node:stream';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Redis } from 'ioredis';
import { MachineConnectivity, MachineOperational, ModerationStatus, PrismaClient } from '@prisma/client';

// Full HTTP-level regression test for machine-diagnostics-routes.ts, driven over
// real app.inject() with genuine Ed25519-signed v2 agent requests and real
// owner sessions, against a real local Postgres + Redis - not a re-simulation
// of the route logic. Same harness pattern as
// workspace-gateway-register-e2e.test.ts. Focus: the two things a diagnostic/
// repair route must never allow - (1) a machine authenticating or acting as a
// DIFFERENT machine, (2) an owner reading or acting on a machine they don't own.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/gpubnb';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-0123456789abcdef';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';

const { registerMachineDiagnosticsRoutes } = await import('../src/machine-diagnostics-routes.js');
const { config } = await import('../src/config.js');

const hasDb = Boolean(process.env.DATABASE_URL);

function tokenHash(token: string): string {
  return crypto.createHmac('sha256', config.SESSION_SECRET).update(token).digest('hex');
}

function signedAgentRequest(method: string, routePath: string, machineId: string, keyPair: nacl.SignKeyPair, body: unknown) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodySha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const canonical = `${method}|${routePath}|${machineId}|${timestamp}|${nonce}|${bodySha256}`;
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(canonical), keyPair.secretKey));
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'x-agent-signature-version': '2',
      'x-agent-timestamp': timestamp,
      'x-agent-nonce': nonce,
      'x-agent-body-sha256': bodySha256,
      'x-agent-signature-v2': signature,
    },
  };
}

test('agent diagnostic routes: cross-machine auth is rejected, owner isolation holds, and a quarantined agent can still run a real diagnostic end-to-end', { skip: !hasDb }, async (t) => {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000,
  });
  try {
    await prisma.$connect();
    redis.on('error', () => {});
    await redis.connect();
  } catch (error) {
    t.skip(`no reachable local Postgres/Redis: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    redis.disconnect();
    return;
  }

  const suffix = crypto.randomBytes(6).toString('hex');
  const now = new Date();
  const keyPairA = nacl.sign.keyPair();
  const keyPairB = nacl.sign.keyPair();

  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await prisma.$disconnect();
    redis.disconnect();
  });

  const app = Fastify();
  await app.register(cookie);
  app.addHook('preParsing', (request, _reply, payload, done) => {
    const chunks: Buffer[] = [];
    const capture = new Transform({
      transform(chunk: Buffer, _enc, callback) { chunks.push(Buffer.from(chunk)); callback(null, chunk); },
    });
    capture.once('end', () => { (request as { rawBody?: Buffer }).rawBody = Buffer.concat(chunks); });
    done(null, payload.pipe(capture as never));
  });
  registerMachineDiagnosticsRoutes(app, prisma, redis as never);
  await app.ready();
  cleanup.push(() => app.close());

  const ownerA = await prisma.user.create({ data: { wallet: `owner_a_${suffix}`, pseudonym: `owner_a_${suffix}`, canHost: true } });
  cleanup.push(() => prisma.user.delete({ where: { id: ownerA.id } }));
  const ownerB = await prisma.user.create({ data: { wallet: `owner_b_${suffix}`, pseudonym: `owner_b_${suffix}`, canHost: true } });
  cleanup.push(() => prisma.user.delete({ where: { id: ownerB.id } }));

  const machineA = await prisma.machine.create({
    data: {
      ownerId: ownerA.id,
      agentPublicKey: bs58.encode(keyPairA.publicKey),
      connectivity: MachineConnectivity.ONLINE,
      operational: MachineOperational.UNAVAILABLE,
      moderationStatus: ModerationStatus.QUARANTINED,
      quarantineReasonCode: 'GPU_HEALTH_CHECK_FAILED',
      quarantinedAt: now,
      lastHeartbeatAt: now,
      dockerAvailable: true,
      nvidiaRuntimeAvailable: true,
      driverVersion: '550.10',
      ramTotalMiB: 16_384,
    },
  });
  cleanup.push(() => prisma.machine.delete({ where: { id: machineA.id } }));
  const machineB = await prisma.machine.create({
    data: {
      ownerId: ownerB.id,
      agentPublicKey: bs58.encode(keyPairB.publicKey),
      connectivity: MachineConnectivity.ONLINE,
      operational: MachineOperational.AVAILABLE,
      moderationStatus: ModerationStatus.CLEAR,
    },
  });
  cleanup.push(() => prisma.machine.delete({ where: { id: machineB.id } }));

  const sessionTokenA = crypto.randomBytes(32).toString('base64url');
  await redis.set(`session:${tokenHash(sessionTokenA)}`, JSON.stringify({ userId: ownerA.id, wallet: ownerA.wallet, createdAt: now.toISOString(), lastSeenAt: now.toISOString() }), 'EX', 3600);
  cleanup.push(() => redis.del(`session:${tokenHash(sessionTokenA)}`));
  const cookieA = `${config.SESSION_COOKIE_NAME}=${sessionTokenA}`;

  const sessionTokenB = crypto.randomBytes(32).toString('base64url');
  await redis.set(`session:${tokenHash(sessionTokenB)}`, JSON.stringify({ userId: ownerB.id, wallet: ownerB.wallet, createdAt: now.toISOString(), lastSeenAt: now.toISOString() }), 'EX', 3600);
  cleanup.push(() => redis.del(`session:${tokenHash(sessionTokenB)}`));
  const cookieB = `${config.SESSION_COOKIE_NAME}=${sessionTokenB}`;

  // --- Security: owner B cannot see or act on owner A's machine ---
  const crossOwnerRead = await app.inject({
    method: 'GET', url: `/rental/machines/${machineA.id}/diagnostics`, headers: { cookie: cookieB },
  });
  assert.equal(crossOwnerRead.statusCode, 404, 'a different owner must not be able to read another owner\'s machine diagnostics');

  const crossOwnerRerun = await app.inject({
    method: 'POST', url: `/rental/machines/${machineA.id}/diagnostics/rerun`, headers: { cookie: cookieB },
  });
  assert.equal(crossOwnerRerun.statusCode, 404, 'a different owner must not be able to trigger a diagnostic on another owner\'s machine');

  // --- Security: a machine cannot authenticate to poll/report as a DIFFERENT machine ---
  const nextPathA = `/agent/diagnostics/next/${machineA.id}`;
  const forgedNext = signedAgentRequest('GET', nextPathA, machineA.id, keyPairB, undefined); // signed with B's key, claiming to be A
  const forgedNextResponse = await app.inject({ method: 'GET', url: nextPathA, headers: forgedNext.headers });
  assert.equal(forgedNextResponse.statusCode, 401, 'machine B\'s key must never authenticate as machine A');

  // --- The owner (A) triggers a real diagnostic ---
  const rerunResponse = await app.inject({
    method: 'POST', url: `/rental/machines/${machineA.id}/diagnostics/rerun`, headers: { cookie: cookieA },
  });
  assert.equal(rerunResponse.statusCode, 201);
  const { diagnosticRunId } = rerunResponse.json() as { diagnosticRunId: string };
  assert.ok(diagnosticRunId);

  // --- The agent for A (correctly authenticated) polls and finds it, even though QUARANTINED ---
  const realNext = signedAgentRequest('GET', nextPathA, machineA.id, keyPairA, undefined);
  const nextResponse = await app.inject({ method: 'GET', url: nextPathA, headers: realNext.headers });
  assert.equal(nextResponse.statusCode, 200, 'a quarantined machine must still be able to authenticate and poll for its own diagnostic');
  const nextBody = nextResponse.json() as { diagnosticRunId: string | null; diagnosticImage: string | null };
  assert.equal(nextBody.diagnosticRunId, diagnosticRunId);

  // --- The agent for A reports a real PASS result; machine B's key must not be able to submit it ---
  const resultPath = `/agent/diagnostics/${diagnosticRunId}/result`;
  const resultBody = { machineId: machineA.id, gpuDetected: true, gpuUuid: 'GPU-real-uuid', summary: 'ok', metrics: {} };
  const forgedResult = signedAgentRequest('POST', resultPath, machineA.id, keyPairB, resultBody);
  const forgedResultResponse = await app.inject({ method: 'POST', url: resultPath, headers: forgedResult.headers, payload: forgedResult.payload });
  assert.equal(forgedResultResponse.statusCode, 401, 'machine B\'s key must never be able to submit a result for machine A\'s diagnostic run');

  const realResult = signedAgentRequest('POST', resultPath, machineA.id, keyPairA, resultBody);
  const resultResponse = await app.inject({ method: 'POST', url: resultPath, headers: realResult.headers, payload: realResult.payload });
  assert.equal(resultResponse.statusCode, 200);
  const resultJson = resultResponse.json() as { cleared: boolean };
  assert.equal(resultJson.cleared, true, 'every mandatory check reported PASS - the quarantine must be lifted by real evidence');

  // --- Host now reflects the real, cleared state, visible only to its real owner ---
  const finalRead = await app.inject({ method: 'GET', url: `/rental/machines/${machineA.id}/diagnostics`, headers: { cookie: cookieA } });
  assert.equal(finalRead.statusCode, 200);
  const finalState = finalRead.json() as { state: { state: string }; quarantine: { active: boolean } };
  assert.equal(finalState.quarantine.active, false);
  // This fixture never registers an Accelerator row (out of scope for this
  // security/auth-focused test - the full QUARANTINED->READY_TO_PUBLISH chain
  // with a real accelerator is proven by quarantine-diagnostics-system.test.ts's
  // end-to-end test), so the state falls through to GPU_NOT_DETECTED rather than
  // READY_TO_PUBLISH - the important assertion is that it is no longer QUARANTINED.
  assert.notEqual(finalState.state.state, 'QUARANTINED');

  // --- A duplicate result submission for the same (now-completed) run is rejected, not silently re-applied ---
  const duplicateResult = signedAgentRequest('POST', resultPath, machineA.id, keyPairA, resultBody);
  const duplicateResponse = await app.inject({ method: 'POST', url: resultPath, headers: duplicateResult.headers, payload: duplicateResult.payload });
  assert.equal(duplicateResponse.statusCode, 409, 'a diagnostic run that already completed must reject a second result, not silently re-apply it');
});

test('a stale (timed-out) RUNNING run never shadows a fresh one, and self-heals to TIMED_OUT - regression for a real bug found live against production', { skip: !hasDb }, async (t) => {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000,
  });
  try {
    await prisma.$connect();
    redis.on('error', () => {});
    await redis.connect();
  } catch (error) {
    t.skip(`no reachable local Postgres/Redis: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    redis.disconnect();
    return;
  }

  const suffix = crypto.randomBytes(6).toString('hex');
  const keyPair = nacl.sign.keyPair();
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await prisma.$disconnect();
    redis.disconnect();
  });

  const app = Fastify();
  await app.register(cookie);
  app.addHook('preParsing', (request, _reply, payload, done) => {
    const chunks: Buffer[] = [];
    const capture = new Transform({
      transform(chunk: Buffer, _enc, callback) { chunks.push(Buffer.from(chunk)); callback(null, chunk); },
    });
    capture.once('end', () => { (request as { rawBody?: Buffer }).rawBody = Buffer.concat(chunks); });
    done(null, payload.pipe(capture as never));
  });
  registerMachineDiagnosticsRoutes(app, prisma, redis as never);
  await app.ready();
  cleanup.push(() => app.close());

  const owner = await prisma.user.create({ data: { wallet: `owner_stale_${suffix}`, pseudonym: `owner_stale_${suffix}`, canHost: true } });
  cleanup.push(() => prisma.user.delete({ where: { id: owner.id } }));
  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id,
      agentPublicKey: bs58.encode(keyPair.publicKey),
      connectivity: MachineConnectivity.ONLINE,
      operational: MachineOperational.UNAVAILABLE,
      moderationStatus: ModerationStatus.QUARANTINED,
      quarantineReasonCode: 'UNKNOWN',
    },
  });
  cleanup.push(() => prisma.machine.delete({ where: { id: machine.id } }));

  // A stale RUNNING run - exactly what a real diagnostic looks like a few
  // minutes after the agent never reported back (crash, network loss).
  const { DIAGNOSTIC_TIMEOUT_MS } = await import('../src/diagnostic-run-service.js');
  const staleRun = await prisma.diagnosticRun.create({
    data: {
      machineId: machine.id,
      status: 'RUNNING',
      triggeredBy: 'OWNER',
      startedAt: new Date(Date.now() - DIAGNOSTIC_TIMEOUT_MS - 60_000),
    },
  });

  // A genuinely fresh run, created afterwards - what the owner sees as "current".
  const freshRun = await prisma.diagnosticRun.create({
    data: { machineId: machine.id, status: 'RUNNING', triggeredBy: 'OWNER' },
  });

  const nextPath = `/agent/diagnostics/next/${machine.id}`;
  const signed = signedAgentRequest('GET', nextPath, machine.id, keyPair, undefined);
  const response = await app.inject({ method: 'GET', url: nextPath, headers: signed.headers });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { diagnosticRunId: string | null };
  assert.equal(body.diagnosticRunId, freshRun.id, 'the agent must be handed the fresh run, never shadowed by an older stale one');

  const staleRowAfter = await prisma.diagnosticRun.findUniqueOrThrow({ where: { id: staleRun.id } });
  assert.equal(staleRowAfter.status, 'TIMED_OUT', 'the stale run must be self-healed to TIMED_OUT, not left as a permanent RUNNING zombie');
  assert.equal(staleRowAfter.error, 'agent_never_reported_result');
});

test('force-clear: never accessible to the owner, requires the internal token, and a CRITICAL-severity reason requires an explicit risk confirmation naming that exact code', { skip: !hasDb }, async (t) => {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000,
  });
  try {
    await prisma.$connect();
    redis.on('error', () => {});
    await redis.connect();
  } catch (error) {
    t.skip(`no reachable local Postgres/Redis: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    redis.disconnect();
    return;
  }

  const suffix = crypto.randomBytes(6).toString('hex');
  const now = new Date();
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await prisma.$disconnect();
    redis.disconnect();
  });

  const app = Fastify();
  await app.register(cookie);
  registerMachineDiagnosticsRoutes(app, prisma, redis as never);
  await app.ready();
  cleanup.push(() => app.close());

  const owner = await prisma.user.create({ data: { wallet: `owner_fc_${suffix}`, pseudonym: `owner_fc_${suffix}`, canHost: true } });
  cleanup.push(() => prisma.user.delete({ where: { id: owner.id } }));
  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id,
      agentPublicKey: `agentkey_fc_${suffix}`,
      connectivity: MachineConnectivity.ONLINE,
      operational: MachineOperational.UNAVAILABLE,
      moderationStatus: ModerationStatus.QUARANTINED,
      quarantineReasonCode: 'CRITICAL_GPU_IDENTITY_CHANGE',
      quarantinedAt: now,
    },
  });
  cleanup.push(() => prisma.machine.delete({ where: { id: machine.id } }));

  const forcePath = `/internal/machines/${machine.id}/quarantine/force-clear`;
  const body = { operatorId: 'ops-1', reason: 'manually verified hardware on site' };

  const noToken = await app.inject({ method: 'POST', url: forcePath, payload: body });
  assert.equal(noToken.statusCode, 401, 'force-clear must require the internal service token');

  const wrongToken = await app.inject({ method: 'POST', url: forcePath, headers: { authorization: 'Bearer not-the-real-token' }, payload: body });
  assert.equal(wrongToken.statusCode, 401);

  const authHeaders = { authorization: `Bearer ${config.INTERNAL_SERVICE_TOKEN}` };
  const noRiskConfirmation = await app.inject({ method: 'POST', url: forcePath, headers: authHeaders, payload: body });
  assert.equal(noRiskConfirmation.statusCode, 409, 'a CRITICAL-severity reason must not be force-cleared without an explicit risk confirmation');
  assert.equal((noRiskConfirmation.json() as { error: string }).error, 'risk_confirmation_required');

  const wrongRiskConfirmation = await app.inject({
    method: 'POST', url: forcePath, headers: authHeaders,
    payload: { ...body, confirmRisk: 'GPU_UNAVAILABLE' }, // does not match the machine's actual reasonCode
  });
  assert.equal(wrongRiskConfirmation.statusCode, 409, 'the risk confirmation must name the exact current reasonCode, not just any code');

  const machineBeforeForce = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
  assert.equal(machineBeforeForce.moderationStatus, ModerationStatus.QUARANTINED, 'still quarantined after every rejected attempt');

  const correctForce = await app.inject({
    method: 'POST', url: forcePath, headers: authHeaders,
    payload: { ...body, confirmRisk: 'CRITICAL_GPU_IDENTITY_CHANGE' },
  });
  assert.equal(correctForce.statusCode, 200);
  const machineAfterForce = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
  assert.equal(machineAfterForce.moderationStatus, ModerationStatus.CLEAR);

  const history = await prisma.machineQuarantineEvent.findFirstOrThrow({ where: { machineId: machine.id, status: 'CLEARED' } });
  const details = history.details as { forced?: boolean; forcedByAdminId?: string };
  assert.equal(details.forced, true, 'a forced clear must never be indistinguishable from an ordinary diagnostic-driven one in history');
  assert.equal(details.forcedByAdminId, 'ops-1');
});
