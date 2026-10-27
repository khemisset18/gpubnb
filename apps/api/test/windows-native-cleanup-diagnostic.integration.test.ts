import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { resourceFenceKey, resourceLeaseKey } from '../src/resource-lease.js';

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/gpubnb';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-0123456789abcdef';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';
const { registerMachineDiagnosticsRoutes } = await import('../src/machine-diagnostics-routes.js');
const { config } = await import('../src/config.js');

test('native quarantine recovery HTTP protocol preserves auth, leases and Docker gates in real Postgres/Redis', async (t) => {
  const db = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000 });
  redis.on('error', () => {});
  try { await db.$connect(); await redis.connect(); }
  catch (error) {
    t.skip(`no reachable local Postgres/Redis: ${(error as Error).message}`);
    await db.$disconnect(); redis.disconnect(); return;
  }
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await db.$disconnect(); redis.disconnect();
  });
  const suffix = crypto.randomBytes(6).toString('hex');
  const now = new Date();
  const startedAt = new Date(now.getTime() - 300_000);
  const key = nacl.sign.keyPair();
  const owner = await db.user.create({ data: { wallet: `native_cleanup_${suffix}`, pseudonym: `cleanup_${suffix}`, canHost: true } });
  cleanup.push(() => db.user.delete({ where: { id: owner.id } }));
  const machine = await db.machine.create({ data: {
    ownerId: owner.id, agentPublicKey: bs58.encode(key.publicKey), connectivity: 'ONLINE', operational: 'UNAVAILABLE',
    moderationStatus: 'QUARANTINED', quarantineReasonCode: 'WORKSPACE_CLEANUP_FAILED', quarantinedAt: now,
    dockerAvailable: true, nvidiaRuntimeAvailable: true, driverVersion: 'fixture-driver', lastHeartbeatAt: now,
  } });
  cleanup.push(() => db.machine.delete({ where: { id: machine.id } }));
  const hardwareUuid = `GPU-${crypto.randomUUID()}`;
  const accelerator = await db.accelerator.create({ data: {
    machineId: machine.id, hardwareUuid, vendor: 'NVIDIA', model: 'CI fixture', vramMiB: 4096,
    moderationStatus: 'QUARANTINED', status: 'QUARANTINED',
  } });
  const resourceId = `gpu_${accelerator.id}`;
  await db.miningResource.create({ data: {
    id: resourceId, machineId: machine.id, acceleratorId: accelerator.id, kind: 'GPU',
    resourceKey: hardwareUuid, displayName: 'CI fixture', runtimeState: 'IDLE',
  } });
  const definition = await db.workspaceDefinition.create({ data: {
    slug: `cleanup-fixture-${suffix}`, name: 'CI fixture', category: 'TEST', manifest: {},
  } });
  cleanup.push(() => db.workspaceDefinition.delete({ where: { id: definition.id } }));
  const workspace = await db.machineWorkspace.create({ data: {
    machineId: machine.id, workspaceId: definition.id, compatibilityScore: 100, state: 'READY', analysis: {},
  } });
  cleanup.push(() => db.machineWorkspace.delete({ where: { id: workspace.id } }));
  const listing = await db.gpuListing.create({ data: {
    ownerId: owner.id, machineId: machine.id, title: 'CI native cleanup fixture', description: 'CI only',
    hourlyLamports: 1n, status: 'PENDING_GPU_VERIFICATION', resourceMode: 'SELECTED_ACCELERATORS',
  } });
  cleanup.push(() => db.gpuListing.delete({ where: { id: listing.id } }));
  // Terminal, unpaid test data in the disposable CI database, never a booking API call.
  const booking = await db.booking.create({ data: {
    buyerId: owner.id, listingId: listing.id, idempotencyKey: `cleanup_${suffix}`, startsAt: startedAt, endsAt: now,
    quotedLamports: 0n, expectedSeconds: 300, status: 'REFUNDED',
  } });
  cleanup.push(() => db.booking.delete({ where: { id: booking.id } }));
  await db.acceleratorAllocation.create({ data: {
    bookingId: booking.id, acceleratorId: accelerator.id, startsAt: startedAt, endsAt: now, releasedAt: now, status: 'RELEASED',
  } });
  const session = await db.workspaceSession.create({ data: {
    bookingId: booking.id, renterId: owner.id, machineId: machine.id, machineWorkspaceId: workspace.id,
    status: 'QUARANTINED', runtimeBackend: 'WINDOWS_NATIVE', isolationType: 'WINDOWS_NATIVE',
    resourceLimits: {}, expiresAt: now, endedAt: now,
  } });
  await db.machineQuarantineEvent.create({ data: {
    machineId: machine.id, status: 'ENTERED', reasonCode: 'WORKSPACE_CLEANUP_FAILED', reason: 'CI fixture',
    source: 'workspace-gateway.stopped', details: { sessionId: session.id },
  } });
  const fenceKey = resourceFenceKey(resourceId);
  const leaseKey = resourceLeaseKey(resourceId);
  await redis.set(fenceKey, '90');
  cleanup.push(() => redis.del(fenceKey, leaseKey));
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHmac('sha256', config.SESSION_SECRET).update(token).digest('hex');
  await redis.set(`session:${hash}`, JSON.stringify({ userId: owner.id, wallet: owner.wallet,
    createdAt: now.toISOString(), lastSeenAt: now.toISOString() }), 'EX', 3600);
  cleanup.push(() => redis.del(`session:${hash}`));
  const app = Fastify();
  await app.register(cookie);
  app.addHook('preParsing', (request, _reply, payload, done) => {
    const chunks: Buffer[] = [];
    const capture = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk)); callback(null, chunk);
    } });
    capture.once('end', () => { request.rawBody = Buffer.concat(chunks); });
    done(null, payload.pipe(capture as never));
  });
  registerMachineDiagnosticsRoutes(app, db, redis);
  await app.ready();
  cleanup.push(() => app.close());

  function signed(path: string, body: unknown, signKey = key) {
    const method = body === undefined ? 'GET' as const : 'POST' as const;
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodySha256 = crypto.createHash('sha256').update(payload).digest('hex');
    const canonical = `${method}|${path}|${machine.id}|${timestamp}|${nonce}|${bodySha256}`;
    return { method, url: path, ...(body === undefined ? {} : { payload }), headers: {
      'content-type': 'application/json', 'x-agent-signature-version': '2', 'x-agent-timestamp': timestamp,
      'x-agent-nonce': nonce, 'x-agent-body-sha256': bodySha256,
      'x-agent-signature-v2': bs58.encode(nacl.sign.detached(Buffer.from(canonical), signKey.secretKey)),
    } };
  }
  async function startRun() {
    const response = await app.inject({ method: 'POST', url: `/rental/machines/${machine.id}/diagnostics/rerun`,
      headers: { cookie: `${config.SESSION_COOKIE_NAME}=${token}` } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().diagnosticRunId as string;
  }
  const target = { sessionId: session.id, resourceId, hardwareUuid };
  const input = { machineId: machine.id, ...target, runtimeGeneration: '90' };
  const result = { machineId: machine.id, gpuDetected: true, gpuUuid: hardwareUuid, summary: 'CI fixture',
    runtimeCleanliness: { unexpectedContainers: [] as string[], unexpectedVolumes: [], unexpectedNetworks: [], expectedSessionIds: [] } };
  const nativeProof = { protocolVersion: 1, ...target, fenceFloor: '90', helperStopped: true, gpuQuiescent: true,
    remainingRentalResourceIds: [], unsafeRuntimeResourceIds: [] };

  let runId = await startRun();
  const next = await app.inject(signed(`/agent/diagnostics/next/${machine.id}`, undefined));
  assert.equal(next.statusCode, 200, next.body);
  assert.deepEqual(next.json().nativeCleanupTarget, target);
  assert.equal(next.json().nativeCleanupRequired, true);
  assert.deepEqual(next.json().expectedRuntimeSessionIds, []);
  const authorityPath = `/agent/diagnostics/${runId}/native-cleanup-authority`;
  assert.equal((await app.inject(signed(authorityPath, input, nacl.sign.keyPair()))).statusCode, 401);
  const legacy = signed(authorityPath, input);
  legacy.headers['x-agent-signature-version'] = '1';
  assert.equal((await app.inject(legacy)).statusCode, 401);
  const tampered = signed(authorityPath, input);
  tampered.payload = Buffer.from(JSON.stringify({ ...input, resourceId: 'resource_other_01' }));
  assert.equal((await app.inject(tampered)).statusCode, 401);
  const valid = signed(authorityPath, input);
  const decision = await app.inject(valid);
  assert.equal(decision.statusCode, 200, decision.body);
  assert.equal(decision.json().allowed, true);
  assert.equal(decision.json().fenceFloor, '90');
  assert.equal((await app.inject(valid)).statusCode, 401, 'nonce replay must not authorize another cleanup');
  assert.equal(await redis.get(fenceKey), '90');
  assert.equal(await redis.exists(leaseKey), 0);

  // An old Agent's Docker-only proof must never clear this native quarantine.
  let outcome = await app.inject(signed(`/agent/diagnostics/${runId}/result`, result));
  assert.equal(outcome.statusCode, 200, outcome.body);
  assert.equal(outcome.json().cleared, false);
  let stored = await db.diagnosticRun.findUniqueOrThrow({ where: { id: runId } });
  assert.ok((stored.checks as Array<{ name: string; status: string }>).some(c => c.name === 'nativeRuntimeCleanup' && c.status === 'UNKNOWN'));
  assert.equal((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).moderationStatus, 'QUARANTINED');

  // Native proof adds to the existing Docker requirement; it never replaces it.
  runId = await startRun();
  outcome = await app.inject(signed(`/agent/diagnostics/${runId}/result`, {
    ...result, nativeRuntimeCleanup: nativeProof,
    runtimeCleanliness: { ...result.runtimeCleanliness, unexpectedContainers: ['gpubnb-orphan'] },
  }));
  assert.equal(outcome.statusCode, 200, outcome.body);
  assert.equal(outcome.json().cleared, false);
  stored = await db.diagnosticRun.findUniqueOrThrow({ where: { id: runId } });
  assert.ok((stored.checks as Array<{ name: string; status: string }>).some(c => c.name === 'runtimeCleanup' && c.status === 'FAIL'));

  // A changed persistent fence invalidates an otherwise complete proof.
  runId = await startRun();
  await redis.set(fenceKey, '91');
  outcome = await app.inject(signed(`/agent/diagnostics/${runId}/result`, { ...result, nativeRuntimeCleanup: nativeProof }));
  assert.equal(outcome.statusCode, 200, outcome.body);
  assert.equal(outcome.json().cleared, false);

  runId = await startRun();
  outcome = await app.inject(signed(`/agent/diagnostics/${runId}/result`, {
    ...result, nativeRuntimeCleanup: { ...nativeProof, fenceFloor: '91' },
  }));
  assert.equal(outcome.statusCode, 200, outcome.body);
  assert.equal(outcome.json().cleared, true);
  assert.equal((await db.accelerator.findUniqueOrThrow({ where: { id: accelerator.id } })).moderationStatus, 'CLEAR');
  assert.equal(await db.machineQuarantineEvent.count({ where: { machineId: machine.id, resolvedAt: null,
    status: { in: ['ENTERED', 'REENTERED'] } } }), 0);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'REFUNDED');
  assert.equal((await db.acceleratorAllocation.findFirstOrThrow({ where: { bookingId: booking.id } })).status, 'RELEASED');
  assert.equal(await db.booking.count({ where: { listingId: listing.id } }), 1, 'the protocol creates no successor booking');
  assert.equal(await redis.get(fenceKey), '91', 'the diagnostic never deletes or increments a resource fence');
  assert.equal(await redis.exists(leaseKey), 0, 'the diagnostic never creates a resource lease');
});
