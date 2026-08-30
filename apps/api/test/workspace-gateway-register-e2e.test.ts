import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { Transform } from 'node:stream';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Redis } from 'ioredis';
import {
  BookingStatus,
  MachineConnectivity,
  MachineOperational,
  ModerationStatus,
  PrismaClient,
  WorkspaceSessionStatus,
} from '@prisma/client';

import { ensureCompatibleMachineWorkspace } from '../src/machine-workspace-catalog.js';
import { registerWorkspaceRenterRoutes } from '../src/workspace-renter-routes.js';
import { config } from '../src/config.js';

// Full API-level regression test for the two incidents fixed in this repo:
//   1. A WorkspaceSession could read status=READY (and the renter-facing phase
//      literally said "READY") while connectionMetadata was still null, because
//      the job-completion handler set READY before the gateway ever registered.
//   2. Once registered, a second /register call (agent retry, restart, or a
//      runtimeId/localPort refresh) must stay idempotent - no duplicate booking
//      transitions, no thrown error, no broken connectionMetadata.
//
// This test drives the REAL route handlers (registerWorkspaceRenterRoutes, which
// also registers the gateway routes) over real HTTP via app.inject(), against a
// real local Postgres + Redis, with a genuine Ed25519-signed v2 agent request -
// not a re-implementation of the logic under test.
//
// It does not boot server.ts itself (a large monolith), so /agent/jobs/:id/complete
// is not exercised here: that transition is reproduced with the identical Prisma
// write it performs (status: PREPARING, no connectionMetadata) before the routes
// under test take over. The chain this test proves - GET status before/after
// register, POST /workspace/access before/after, and register idempotence - is
// exactly the chain that broke in production.

const hasDb = Boolean(process.env.DATABASE_URL);

function tokenHash(token: string): string {
  return crypto.createHmac('sha256', config.SESSION_SECRET).update(token).digest('hex');
}

function signedAgentRequest(method: string, routePath: string, machineId: string, keyPair: nacl.SignKeyPair, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body));
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

test('gateway register is the only thing that makes a Developer workspace openable, and is idempotent', { skip: !hasDb }, async (t) => {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  });
  try {
    await prisma.$connect();
    redis.on('error', () => {});
    await redis.connect();
  } catch (error) {
    t.skip(`no reachable local Postgres/Redis for this E2E test: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    redis.disconnect();
    return;
  }

  const suffix = crypto.randomBytes(6).toString('hex');
  const now = new Date();
  const keyPair = nacl.sign.keyPair();
  const machinePublicKey = bs58.encode(keyPair.publicKey);

  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await prisma.$disconnect();
    redis.disconnect();
  });

  const app = Fastify();
  await app.register(cookie);
  // Same rawBody capture hook as the real server, required by the v2 agent
  // signature scheme (it signs a hash of the exact raw request bytes).
  app.addHook('preParsing', (request, _reply, payload, done) => {
    const chunks: Buffer[] = [];
    const capture = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        chunks.push(Buffer.from(chunk));
        callback(null, chunk);
      },
    });
    capture.once('end', () => {
      (request as { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
    });
    done(null, payload.pipe(capture as never));
  });
  registerWorkspaceRenterRoutes(app, prisma, redis as never);
  await app.ready();
  cleanup.push(() => app.close());

  // --- Fixtures: renter with a real session, machine, developer workspace, booking, job ---
  const renter = await prisma.user.create({ data: { wallet: `renter_${suffix}`, pseudonym: `renter_${suffix}` } });
  cleanup.push(() => prisma.user.delete({ where: { id: renter.id } }));
  const owner = await prisma.user.create({ data: { wallet: `owner_${suffix}`, pseudonym: `owner_${suffix}`, canHost: true } });
  cleanup.push(() => prisma.user.delete({ where: { id: owner.id } }));

  const sessionToken = crypto.randomBytes(32).toString('base64url');
  await redis.set(
    `session:${tokenHash(sessionToken)}`,
    JSON.stringify({ userId: renter.id, wallet: renter.wallet, createdAt: now.toISOString(), lastSeenAt: now.toISOString() }),
    'EX',
    3600,
  );
  cleanup.push(() => redis.del(`session:${tokenHash(sessionToken)}`));
  const cookieHeader = `${config.SESSION_COOKIE_NAME}=${sessionToken}`;

  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id,
      agentPublicKey: machinePublicKey,
      connectivity: MachineConnectivity.ONLINE,
      operational: MachineOperational.RESERVED,
      moderationStatus: ModerationStatus.CLEAR,
      lastHeartbeatAt: now,
      lastCudaProbeOk: true,
      cudaVersion: '12.4',
      vramMiB: 4_096,
      dockerAvailable: true,
      nvidiaRuntimeAvailable: true,
      virtualizationAvailable: true,
      verifiedAt: now,
      ramTotalMiB: 16_384,
      diskTotalMiB: 51_200,
    },
  });
  cleanup.push(() => prisma.machine.delete({ where: { id: machine.id } }));

  const machineWorkspace = await ensureCompatibleMachineWorkspace(prisma, machine.id, 'developer');

  const listing = await prisma.gpuListing.create({
    data: {
      ownerId: owner.id,
      machineId: machine.id,
      title: `E2E gateway listing ${suffix}`,
      description: 'Seeded by workspace-gateway-register-e2e.test.ts',
      hourlyLamports: 1_000_000n,
      status: 'ACTIVE',
    },
  });
  cleanup.push(() => prisma.gpuListing.delete({ where: { id: listing.id } }));

  const booking = await prisma.booking.create({
    data: {
      buyerId: renter.id,
      listingId: listing.id,
      idempotencyKey: `idem_${suffix}`,
      startsAt: now,
      endsAt: new Date(now.getTime() + 3_600_000),
      quotedLamports: 1_000_000n,
      expectedSeconds: 1_500,
      status: BookingStatus.FUNDED,
    },
  });
  cleanup.push(() => prisma.booking.delete({ where: { id: booking.id } }));

  // Required by the guard_booking_resource_lifecycle trigger: FUNDED/STARTING/
  // ACTIVE bookings must always carry a live resource allocation.
  await prisma.machineAllocation.create({
    data: { bookingId: booking.id, machineId: machine.id, status: 'ACTIVE', startsAt: booking.startsAt, endsAt: booking.endsAt },
  });

  const job = await prisma.job.create({
    data: {
      bookingId: booking.id, renterId: renter.id, machineId: machine.id,
      type: 'WORKSPACE_PREPARE', parameters: { workspaceSlug: 'developer', timeoutSeconds: 1200 },
      status: 'COMPLETED', finishedAt: now,
    },
  });
  cleanup.push(() => prisma.job.delete({ where: { id: job.id } }));

  // Reproduces exactly what POST /agent/jobs/:id/complete writes for a
  // WORKSPACE_PREPARE job today (server.ts): the container/runtime is proven
  // ready, but the gateway has not registered yet.
  const session = await prisma.workspaceSession.create({
    data: {
      bookingId: booking.id, renterId: renter.id, machineId: machine.id,
      machineWorkspaceId: machineWorkspace.id, jobId: job.id,
      status: WorkspaceSessionStatus.READY, isolationType: 'DOCKER',
      resourceLimits: { maxRamMiB: 4096, maxCpuCores: 2, storageQuotaMiB: 10240, networkAccess: 'RESTRICTED', autoStopMinutes: 60 },
      connectionType: 'GPUBNB_GATEWAY', preparationProgress: 100, preparationStep: 'CONNECTION_READY',
      readyAt: now, expiresAt: booking.endsAt,
    },
  });

  // --- 1. Before /register: must never claim the workspace is openable ---
  const before = await app.inject({ method: 'GET', url: `/bookings/${booking.id}/workspace`, headers: { cookie: cookieHeader } });
  assert.equal(before.statusCode, 200);
  const beforeBody = before.json();
  assert.equal(beforeBody.status, 'READY', 'sanity check: the raw DB status really is READY at this point');
  assert.equal(beforeBody.canOpen, false, 'canOpen must be false: connectionMetadata is still null');
  assert.equal(beforeBody.blockedReason, 'GATEWAY_NOT_READY');
  assert.equal(beforeBody.preparation.phase, 'GATEWAY_NOT_READY', 'the phase must never literally say READY here');

  const accessBefore = await app.inject({
    method: 'POST', url: `/bookings/${booking.id}/workspace/access`, headers: { cookie: cookieHeader },
  });
  assert.equal(accessBefore.statusCode, 409);
  assert.deepEqual(accessBefore.json(), { error: 'workspace_gateway_not_ready' });

  // --- 2. Agent registers the real gateway connection ---
  const registerBody = { machineId: machine.id, runtimeId: `runtime-${suffix}`, localPort: 41234 };
  const registerRoute = `/agent/workspace-gateway/${session.id}/register`;
  const signed1 = signedAgentRequest('POST', registerRoute, machine.id, keyPair, registerBody);
  const register1 = await app.inject({ method: 'POST', url: registerRoute, headers: signed1.headers, payload: signed1.payload });
  assert.equal(register1.statusCode, 200, JSON.stringify(register1.json()));
  const gatewayPath = register1.json().gatewayPath;
  assert.equal(gatewayPath, `/workspace-gateway/${session.id}`);

  const bookingAfterRegister = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(bookingAfterRegister.status, BookingStatus.STARTING, 'first registration must start the booking timer');

  // --- 3. After /register: now genuinely openable ---
  const after = await app.inject({ method: 'GET', url: `/bookings/${booking.id}/workspace`, headers: { cookie: cookieHeader } });
  const afterBody = after.json();
  assert.equal(afterBody.canOpen, true);
  assert.equal(afterBody.blockedReason, null);
  assert.equal(afterBody.preparation.phase, 'READY');

  const access = await app.inject({ method: 'POST', url: `/bookings/${booking.id}/workspace/access`, headers: { cookie: cookieHeader } });
  assert.equal(access.statusCode, 200, JSON.stringify(access.json()));
  const openPath: string = access.json().openPath;
  assert.ok(openPath.startsWith(`${gatewayPath}?grant=`), `openPath must be scoped to the registered gatewayPath, got ${openPath}`);

  // --- 4. Idempotence: a second register (agent retry / restart) must not
  // duplicate the booking transition or break connectionMetadata ---
  const signed2 = signedAgentRequest('POST', registerRoute, machine.id, keyPair, registerBody);
  const register2 = await app.inject({ method: 'POST', url: registerRoute, headers: signed2.headers, payload: signed2.payload });
  assert.equal(register2.statusCode, 200);
  assert.equal(register2.json().gatewayPath, gatewayPath);

  const bookingAfterSecondRegister = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(bookingAfterSecondRegister.status, BookingStatus.STARTING, 'second register must not re-trigger the first-registration transition');
  assert.equal(bookingAfterSecondRegister.startsAt.getTime(), bookingAfterRegister.startsAt.getTime(), 'second register must not reset the activation window');
});
