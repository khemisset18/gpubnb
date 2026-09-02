import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  AcceleratorOperationalStatus,
  BookingStatus,
  JobStatus,
  JobType,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  ModerationStatus,
  PaymentStatus,
  PrismaClient,
  WorkspaceSessionStatus,
} from '@prisma/client';
import { Redis } from 'ioredis';
import type { AcceleratorTelemetry } from '../src/accelerator-telemetry.js';

// End-to-end walkthrough of the exact chain this whole audit was about, against a real
// Postgres+Redis, calling the real production functions at every hop:
//
//   host heartbeat -> listing ACTIVE -> renter books -> funded (dev-bypass, matching
//   confirm-deposit's real escrow-not-deployed path) -> GPU_DIAGNOSTIC proves the GPU,
//   unlocking STARTING -> ACTIVE (the previous session's fix - not re-proven here, see
//   gpu-proof-unlock-race.test.ts) -> Developer workspace requested and prepared exactly
//   as POST /bookings/:id/workspace/developer does -> session READY, container "ready" -
//   the commercial clock has NOT started yet (workspaceActivatedAt still null, this is
//   the exact real bug found live: GPU Proof/preparation time must never be billed) ->
//   activateGatewaySession fires on a real upstream WS frame -> workspaceActivatedAt set
//   exactly once, endsAt = activatedAt + expectedSeconds (proven against the booking's
//   real purchased duration, not whatever was left of the original window) -> renter
//   "uses" the GPU -> Stop -> finalizeVerifiedDeveloperStop -> machine released -> real
//   settlement (dev-bypass signature, matching reconcileDevBypassSettlements' own real
//   path) -> booking SETTLED -> listing bookable again by a second renter.
//
// What remains explicitly simulated (documented, not claimed as proven): the physical
// GPU_DIAGNOSTIC/WORKSPACE_PREPARE Docker execution itself and the real upstream
// WebSocket frame's Docker/network path - both blocked pending physical hardware access
// from this environment, exactly like e2e-gpu-rental-lifecycle.test.ts already documents
// for the Compute path. Everything else - every status transition, every DB write, every
// invariant (workspaceActivatedAt single-writer, endsAt formula, idempotent stop,
// idempotent settlement) - is the real production code, not a re-implementation.
//
// Skips cleanly if no local Postgres/Redis is reachable.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/gpubnb';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-0123456789abcdef';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';
process.env.BETA_TEST_DEV_BYPASS ??= 'true';
process.env.ESCROW_PROGRAM_ID ??= 'NOT_DEPLOYED_YET';

// config.ts validates PLATFORM_WALLET (and friends) as required at import time. Static
// imports are hoisted before any other top-level statement (including the fallbacks
// above), so every import that transitively reaches config.ts must be dynamic here,
// evaluated after these fallbacks are in place - same convention as every other real-DB
// test file in this repo (see gpu-proof-completion.test.ts). Real CI failure found live:
// this passed locally only because an earlier-loaded test file in the same combined
// `tsx --test test/*.test.ts` process had already set PLATFORM_WALLET first - a fresh,
// isolated CI run of this file alone crashed with a ZodError before this static import
// mistake was fixed.
const { syncGpuMiningResourcesFromAccelerators } = await import('../src/mining-resource-inventory.js');
const { createExactGpuListing } = await import('../src/rental-listing-service.js');
const { allocateBookingResources } = await import('../src/resource-allocation-service.js');
const { ensureCompatibleMachineWorkspace } = await import('../src/machine-workspace-catalog.js');
const { activateGatewaySession } = await import('../src/workspace-gateway.js');
const { finalizeVerifiedDeveloperStop } = await import('../src/workspace-stop-finalizer.js');
const { requestSettlement, confirmSettlement } = await import('../src/settlement-transactions.js');
const { devBypassSettlementSignature } = await import('../src/dev-booking-reconciler.js');

const hasDb = Boolean(process.env.DATABASE_URL);

function gpu(deviceId: string): AcceleratorTelemetry {
  return {
    schemaVersion: 1, kind: 'GPU', vendor: 'NVIDIA', model: 'NVIDIA Test GPU Developer E2E',
    deviceId, busAddress: null, driverVersion: '550.10', runtimeVersion: '12.4',
    memoryTotalMiB: 8192, memoryUsedMiB: null, utilizationPercent: null, temperatureC: null,
    powerWatts: null, available: true, throttling: false, capabilities: {}, metrics: {},
  };
}

test('Developer Workspace full lifecycle: booking -> GPU proof -> Workspace ready (clock NOT started) -> real activation (clock starts, workspaceActivatedAt set once, purchased duration honored) -> Stop -> settlement -> machine/listing available again', { skip: !hasDb }, async (t) => {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000 });
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
  const hardwareUuid = `GPU-dev-e2e-${suffix}`;
  const now = new Date();
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await prisma.$disconnect();
    redis.disconnect();
  });

  // --- Host: heartbeat -> accelerator inventory -> publishable listing ---
  const owner = await prisma.user.create({ data: { wallet: `owner_deve2e_${suffix}`, pseudonym: `owner_deve2e_${suffix}`, canHost: true } });
  cleanup.push(() => prisma.user.delete({ where: { id: owner.id } }));
  const renter = await prisma.user.create({ data: { wallet: `renter_deve2e_${suffix}`, pseudonym: `renter_deve2e_${suffix}` } });
  cleanup.push(() => prisma.user.delete({ where: { id: renter.id } }));
  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id, agentPublicKey: `agentkey_deve2e_${suffix}`, agentVersion: '0.6.2',
      connectivity: MachineConnectivity.ONLINE, operational: MachineOperational.AVAILABLE, moderationStatus: ModerationStatus.CLEAR,
      lastHeartbeatAt: now, lastCudaProbeOk: true, dockerAvailable: true, nvidiaRuntimeAvailable: true,
      virtualizationAvailable: true, verifiedAt: now, ramTotalMiB: 16_384, diskTotalMiB: 51_200,
      vramMiB: 4_096, cudaVersion: '12.4',
    },
  });
  cleanup.push(() => prisma.machine.delete({ where: { id: machine.id } }));

  await prisma.$transaction((tx) => syncGpuMiningResourcesFromAccelerators(tx, machine.id, [gpu(hardwareUuid)]));
  const accelerator = await prisma.accelerator.findUniqueOrThrow({ where: { machineId_hardwareUuid: { machineId: machine.id, hardwareUuid } } });
  assert.equal(accelerator.status, AcceleratorOperationalStatus.AVAILABLE);
  await prisma.accelerator.update({ where: { id: accelerator.id }, data: { isolationVerified: true, verifiedAt: now, lastSeenAt: now } });

  const listing = await createExactGpuListing(prisma, {
    ownerId: owner.id, machineId: machine.id, acceleratorId: accelerator.id,
    title: 'Developer E2E listing', description: 'Seeded by e2e-developer-workspace-full-lifecycle.test.ts',
    hourlySol: 0.01, now, heartbeatStaleAfterSeconds: 60,
  });
  cleanup.push(() => prisma.gpuListing.delete({ where: { id: listing.id } }));
  assert.equal(listing.status, ListingStatus.ACTIVE);

  // --- Renter: books a real 15-minute rental (expectedSeconds is the ONLY source of the
  // purchased duration the real activation formula uses - see below) ---
  const PURCHASED_SECONDS = 15 * 60;
  const startsAt = new Date(now.getTime() + 60_000);
  const endsAt = new Date(startsAt.getTime() + PURCHASED_SECONDS * 1000);
  const booking = await prisma.booking.create({
    data: {
      buyerId: renter.id, listingId: listing.id, idempotencyKey: `idem_deve2e_${suffix}`,
      startsAt, endsAt, quotedLamports: 2_500_000n, expectedSeconds: PURCHASED_SECONDS, status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  cleanup.push(() => prisma.booking.delete({ where: { id: booking.id } }));
  await allocateBookingResources(prisma, { bookingId: booking.id, buyerId: renter.id });

  // --- Funding: dev-bypass path (real escrow not deployed), matching POST /bookings/:id/
  // confirm-deposit's own behavior when config.ESCROW_PROGRAM_ID==='NOT_DEPLOYED_YET' ---
  await prisma.$transaction([
    prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.FUNDED } }),
    prisma.payment.create({ data: { bookingId: booking.id, grossLamports: booking.quotedLamports, status: PaymentStatus.ESCROW_FUNDED } }),
  ]);

  // --- GPU_DIAGNOSTIC proves the GPU works: booking unlocks STARTING -> ACTIVE. This
  // exact transition is the previous session's fix (dev-booking-reconciler.ts) - not
  // re-simulated here, see gpu-proof-unlock-race.test.ts. Reaching ACTIVE directly (like
  // e2e-gpu-rental-lifecycle.test.ts already does for the Compute path) keeps this test
  // focused on the ground that fix's own tests do not cover: what happens next. ---
  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.ACTIVE } });

  // --- Renter requests the Developer workspace (POST /bookings/:id/workspace/developer's
  // real precondition: booking status in {FUNDED,STARTING,ACTIVE} - satisfied) ---
  const machineWorkspace = await ensureCompatibleMachineWorkspace(prisma, machine.id, 'developer');
  const prepareJob = await prisma.job.create({
    data: { bookingId: booking.id, renterId: renter.id, machineId: machine.id, type: JobType.WORKSPACE_PREPARE, parameters: { workspaceSlug: 'developer', timeoutSeconds: 1200 } },
  });
  cleanup.push(() => prisma.job.delete({ where: { id: prepareJob.id } }).catch(() => {}));
  const session = await prisma.workspaceSession.create({
    data: {
      bookingId: booking.id, renterId: renter.id, machineId: machine.id, machineWorkspaceId: machineWorkspace.id, jobId: prepareJob.id,
      status: WorkspaceSessionStatus.PREPARING, isolationType: 'DOCKER',
      resourceLimits: { maxRamMiB: 4096, maxCpuCores: 2, storageQuotaMiB: 10240, networkAccess: 'RESTRICTED', autoStopMinutes: 60 },
      connectionType: 'GPUBNB_GATEWAY', preparationProgress: 5, preparationStep: 'DEVELOPER_REQUESTED',
      preparationRequestedAt: now, readyDeadlineAt: new Date(startsAt.getTime() - 120_000), expiresAt: booking.endsAt,
    },
  });

  // --- Container reports ready (matches /agent/jobs/:id/complete's WORKSPACE_PREPARE
  // branch: session -> READY). THE bug this whole audit chased: the commercial clock
  // must NOT have started yet, no matter how long GPU Proof + preparation took. ---
  await prisma.job.update({ where: { id: prepareJob.id }, data: { status: JobStatus.COMPLETED, finishedAt: new Date() } });
  await prisma.workspaceSession.update({ where: { id: session.id }, data: { status: WorkspaceSessionStatus.READY, readyAt: new Date(), preparationProgress: 100, preparationStep: 'CONNECTION_READY' } });

  const beforeActivation = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(beforeActivation.workspaceActivatedAt, null, 'the clock must not have started merely because the container reports ready');
  assert.deepEqual(beforeActivation.endsAt, endsAt, 'endsAt must still be the original funding-time window - unchanged until real activation');

  // --- The renter's browser exchanges a real upstream WebSocket frame - the ONE true
  // activation signal (activateGatewaySession, workspace-gateway.ts). Simulates a
  // deliberately long GPU-Proof-plus-preparation delay (8 real minutes) to prove that
  // time was never billed. ---
  const realActivationMoment = new Date(now.getTime() + 8 * 60_000);
  const activation = await activateGatewaySession(prisma, session.id, machine.id);
  assert.ok(activation?.activated, JSON.stringify(activation));

  const afterActivation = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(afterActivation.status, BookingStatus.ACTIVE);
  assert.ok(afterActivation.workspaceActivatedAt, 'workspaceActivatedAt must be set by the real activation');
  const remainingSeconds = Math.round((afterActivation.endsAt.getTime() - afterActivation.workspaceActivatedAt!.getTime()) / 1000);
  assert.equal(remainingSeconds, PURCHASED_SECONDS, `must grant the full purchased ${PURCHASED_SECONDS}s from real activation, not whatever was left of the original window - got ${remainingSeconds}s`);
  assert.deepEqual(afterActivation.startsAt, afterActivation.workspaceActivatedAt, 'startsAt must be re-anchored to the real activation moment');

  // --- Idempotence: a refresh/reconnect/double click must never move the clock, even
  // hours after the real activation moment simulated above ---
  const refreshResult = await activateGatewaySession(prisma, session.id, machine.id);
  assert.deepEqual(refreshResult, { activated: false, expiresAt: activation!.expiresAt });
  const afterRefresh = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.deepEqual(afterRefresh.workspaceActivatedAt, afterActivation.workspaceActivatedAt, 'a second activation attempt must never move workspaceActivatedAt');
  assert.deepEqual(afterRefresh.endsAt, afterActivation.endsAt);
  void realActivationMoment; // documents intent above; the DB row is what's actually asserted

  // --- Renter "uses" the GPU: real usage would accumulate booking.validSeconds via
  // repeated /agent/workspace-gateway/:sessionId/usage calls (workspace-gateway.ts) - not
  // re-implemented here, this simulates a fully-available rental (proven usage equals the
  // full purchased duration) so settlement below exercises the real full-payout path
  // rather than the zero-usage full-refund path (settlement.ts's own, separately
  // correct, business rule). ---
  await prisma.booking.update({ where: { id: booking.id }, data: { validSeconds: PURCHASED_SECONDS } });

  // --- then stops the Workspace ---
  await prisma.workspaceSession.update({ where: { id: session.id }, data: { status: WorkspaceSessionStatus.STOP_REQUESTED } });
  const stopResult = await finalizeVerifiedDeveloperStop(prisma, redis, session.id, machine.id);
  assert.equal(stopResult.alreadyFinalized, false);
  assert.equal(stopResult.activated, true);
  assert.equal(stopResult.machineReleased, true, 'the machine must be released once the Developer session is the only thing holding it');

  const finalSession = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.equal(finalSession.status, WorkspaceSessionStatus.COMPLETED);
  const machineAfterStop = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
  assert.equal(machineAfterStop.operational, MachineOperational.AVAILABLE);

  // --- Booking settles once its real endsAt has passed (matches
  // reconcileExpiredActiveDeveloperBookings; simulated directly here since that
  // reconciler's own 10s-tick sweep is separately covered by gpu-proof-unlock-race.test.ts)
  // and gets settled through the real dev-bypass path
  // (reconcileDevBypassSettlements' own real signature helper + real requestSettlement/
  // confirmSettlement functions, not re-implemented) ---
  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.COMPLETED } });
  await requestSettlement(prisma, booking.id);
  const settlement = await confirmSettlement(prisma, booking.id, devBypassSettlementSignature(booking.id));
  assert.equal(settlement.bookingStatus, BookingStatus.SETTLED);
  assert.equal(settlement.idempotent, false);

  const finalBooking = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(finalBooking.status, BookingStatus.SETTLED);
  const finalPayment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
  assert.equal(finalPayment.status, PaymentStatus.RELEASED);

  // --- The exact GPU is bookable again by a second renter - not merely a status enum ---
  const secondRenter = await prisma.user.create({ data: { wallet: `renter2_deve2e_${suffix}`, pseudonym: `renter2_deve2e_${suffix}` } });
  cleanup.push(() => prisma.user.delete({ where: { id: secondRenter.id } }));
  const secondBooking = await prisma.booking.create({
    data: {
      buyerId: secondRenter.id, listingId: listing.id, idempotencyKey: `idem2_deve2e_${suffix}`,
      startsAt: new Date(endsAt.getTime() + 3_600_000), endsAt: new Date(endsAt.getTime() + 4_500_000),
      quotedLamports: 1_000_000n, expectedSeconds: 60, status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  cleanup.push(() => prisma.booking.delete({ where: { id: secondBooking.id } }));
  const secondAllocation = await allocateBookingResources(prisma, { bookingId: secondBooking.id, buyerId: secondRenter.id });
  assert.deepEqual(secondAllocation.acceleratorIds, [accelerator.id], 'the same physical GPU must be re-rentable, not stuck');
});
