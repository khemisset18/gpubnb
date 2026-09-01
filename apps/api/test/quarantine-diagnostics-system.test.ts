import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingStatus,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  ModerationStatus,
  PrismaClient,
} from '@prisma/client';

// Real-DB integration tests for the quarantine/diagnostics system (schema
// migration 20260901005635_add_quarantine_diagnostics_lifecycle) - exercises the
// actual production functions (quarantine-service.ts, diagnostic-run-service.ts,
// machine-repair-service.ts, rental-listing-service.ts, resource-allocation-service.ts)
// against a real local Postgres, not a re-simulation of their logic. See
// docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md.

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/gpubnb';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-0123456789abcdef';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';

const { enterQuarantine, clearQuarantine } = await import('../src/quarantine-service.js');
const { createDiagnosticRun, completeDiagnosticRun } = await import('../src/diagnostic-run-service.js');
const { detectAvailableRepair, applyRepair } = await import('../src/machine-repair-service.js');
const { createExactGpuListing, RentalListingError, computeLifecycleStatus } = await import('../src/rental-listing-service.js');
const { allocateBookingResources, ResourceAllocationError } = await import('../src/resource-allocation-service.js');
const { syncGpuMiningResourcesFromAccelerators } = await import('../src/mining-resource-inventory.js');
import type { AcceleratorTelemetry } from '../src/accelerator-telemetry.js';

const hasDb = Boolean(process.env.DATABASE_URL);

function gpu(deviceId: string): AcceleratorTelemetry {
  return {
    schemaVersion: 1, kind: 'GPU', vendor: 'NVIDIA', model: 'NVIDIA Test GPU', deviceId,
    busAddress: null, driverVersion: '550.10', runtimeVersion: '12.4', memoryTotalMiB: 8192,
    memoryUsedMiB: null, utilizationPercent: null, temperatureC: null, powerWatts: null,
    available: true, throttling: false, capabilities: {}, metrics: {},
  };
}

async function seedMachine(prisma: PrismaClient, suffix: string, overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const owner = await prisma.user.create({ data: { wallet: `owner_qd_${suffix}`, pseudonym: `owner_qd_${suffix}`, canHost: true } });
  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id,
      agentPublicKey: `agentkey_qd_${suffix}`,
      connectivity: MachineConnectivity.ONLINE,
      operational: MachineOperational.AVAILABLE,
      moderationStatus: ModerationStatus.CLEAR,
      lastHeartbeatAt: now,
      lastCudaProbeOk: true,
      dockerAvailable: true,
      nvidiaRuntimeAvailable: true,
      verifiedAt: now,
      ramTotalMiB: 16_384,
      diskTotalMiB: 51_200,
      cudaVersion: '12.4',
      driverVersion: '550.10',
      ...overrides,
    },
  });
  return { owner, machine };
}

async function seedMachineWithGpu(prisma: PrismaClient, suffix: string, overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const { owner, machine } = await seedMachine(prisma, suffix, overrides);
  const hardwareUuid = `GPU-qd-${suffix}`;
  await prisma.$transaction((tx) => syncGpuMiningResourcesFromAccelerators(tx, machine.id, [gpu(hardwareUuid)]));
  const accelerator = await prisma.accelerator.findUniqueOrThrow({ where: { machineId_hardwareUuid: { machineId: machine.id, hardwareUuid } } });
  await prisma.accelerator.update({ where: { id: accelerator.id }, data: { isolationVerified: true, verifiedAt: now, lastSeenAt: now } });
  return { owner, machine, accelerator };
}

test('quarantine history is immutable: a second quarantine never overwrites the first, and is recorded as REENTERED', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { machine } = await seedMachine(prisma, 'hist1');
    await prisma.$transaction((tx) => enterQuarantine(tx, {
      machineId: machine.id, reasonCode: 'GPU_HEALTH_CHECK_FAILED', reason: 'first', source: 'test',
    }));
    const afterFirst = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
    assert.equal(afterFirst.moderationStatus, ModerationStatus.QUARANTINED);
    assert.ok(afterFirst.quarantinedAt);
    const firstQuarantinedAt = afterFirst.quarantinedAt!.getTime();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.$transaction((tx) => enterQuarantine(tx, {
      machineId: machine.id, reasonCode: 'DOCKER_UNAVAILABLE', reason: 'second', source: 'test',
    }));
    const afterSecond = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
    assert.equal(afterSecond.quarantineReasonCode, 'DOCKER_UNAVAILABLE', 'the current-state reason updates');
    assert.equal(
      afterSecond.quarantinedAt!.getTime(), firstQuarantinedAt,
      'quarantinedAt reflects the start of the continuous quarantine period, not the latest re-entry',
    );

    const history = await prisma.machineQuarantineEvent.findMany({ where: { machineId: machine.id }, orderBy: { createdAt: 'asc' } });
    assert.equal(history.length, 2, 'both events must survive - the second must never overwrite the first');
    assert.equal(history[0].status, 'ENTERED');
    assert.equal(history[0].reasonCode, 'GPU_HEALTH_CHECK_FAILED');
    assert.equal(history[1].status, 'REENTERED');
    assert.equal(history[1].reasonCode, 'DOCKER_UNAVAILABLE');
  } finally {
    await prisma.$disconnect();
  }
});

test('clearQuarantine resolves open history events and appends a CLEARED entry', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { machine } = await seedMachine(prisma, 'hist2');
    await prisma.$transaction((tx) => enterQuarantine(tx, {
      machineId: machine.id, reasonCode: 'GPU_UNAVAILABLE', reason: 'entered', source: 'test',
    }));
    await prisma.$transaction((tx) => clearQuarantine(tx, {
      machineId: machine.id, reason: 'cleared', source: 'test',
    }));
    const machineRow = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
    assert.equal(machineRow.moderationStatus, ModerationStatus.CLEAR);
    assert.equal(machineRow.quarantineReasonCode, null);
    assert.equal(machineRow.quarantinedAt, null);

    const history = await prisma.machineQuarantineEvent.findMany({ where: { machineId: machine.id }, orderBy: { createdAt: 'asc' } });
    assert.equal(history.length, 2);
    assert.equal(history[0].status, 'ENTERED');
    assert.ok(history[0].resolvedAt, 'the ENTERED event must be marked resolved when cleared');
    assert.equal(history[1].status, 'CLEARED');
  } finally {
    await prisma.$disconnect();
  }
});

test('a forced admin clear is never hidden in history: details.forced is set with the operator id', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { machine } = await seedMachine(prisma, 'hist3');
    await prisma.$transaction((tx) => enterQuarantine(tx, {
      machineId: machine.id, reasonCode: 'AGENT_SECURITY_FAILURE', reason: 'entered', source: 'test',
    }));
    await prisma.$transaction((tx) => clearQuarantine(tx, {
      machineId: machine.id, reason: 'forced by ops', source: 'internal.force-clear', forcedByAdminId: 'operator-42',
    }));
    const clearedEvent = await prisma.machineQuarantineEvent.findFirstOrThrow({ where: { machineId: machine.id, status: 'CLEARED' } });
    const details = clearedEvent.details as { forced?: boolean; forcedByAdminId?: string };
    assert.equal(details.forced, true);
    assert.equal(details.forcedByAdminId, 'operator-42');
  } finally {
    await prisma.$disconnect();
  }
});

test('diagnostic PASS on every mandatory check clears an active quarantine (controlled transition, not a bare heartbeat)', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { machine } = await seedMachine(prisma, 'diag1');
    await prisma.$transaction((tx) => enterQuarantine(tx, {
      machineId: machine.id, reasonCode: 'GPU_HEALTH_CHECK_FAILED', reason: 'entered', source: 'test',
    }));
    const { run } = await createDiagnosticRun(prisma, { machineId: machine.id, triggeredBy: 'OWNER' });
    const now = new Date();
    const checks = ['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'allocation', 'cuda', 'ram'].map((name) => ({
      name, status: 'PASS' as const, value: null, details: '', measuredAt: now.toISOString(), source: 'agent-diagnostic' as const,
    }));
    const outcome = await completeDiagnosticRun(prisma, { diagnosticRunId: run.id, machineId: machine.id, checks, source: 'test', now });
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.cleared, true);
    const machineRow = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
    assert.equal(machineRow.moderationStatus, ModerationStatus.CLEAR);
    assert.equal(machineRow.lastDiagnosticRunId, run.id);
  } finally {
    await prisma.$disconnect();
  }
});

test('diagnostic FAIL on a mandatory check maintains the quarantine with the specific reasonCode', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { machine } = await seedMachine(prisma, 'diag2');
    await prisma.$transaction((tx) => enterQuarantine(tx, {
      machineId: machine.id, reasonCode: 'AGENT_SECURITY_FAILURE', reason: 'entered', source: 'test',
    }));
    const { run } = await createDiagnosticRun(prisma, { machineId: machine.id, triggeredBy: 'OWNER' });
    const now = new Date();
    const checks = ['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'allocation'].map((name) => ({
      name, status: (name === 'docker' ? 'FAIL' : 'PASS') as 'PASS' | 'FAIL', value: null, details: '', measuredAt: now.toISOString(), source: 'agent-diagnostic' as const,
    }));
    const outcome = await completeDiagnosticRun(prisma, { diagnosticRunId: run.id, machineId: machine.id, checks, source: 'test', now });
    assert.equal(outcome.cleared, false);
    const machineRow = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
    assert.equal(machineRow.moderationStatus, ModerationStatus.QUARANTINED);
    assert.equal(machineRow.quarantineReasonCode, 'DOCKER_UNAVAILABLE');
    const history = await prisma.machineQuarantineEvent.findMany({ where: { machineId: machine.id }, orderBy: { createdAt: 'asc' } });
    assert.equal(history.at(-1)!.status, 'REENTERED');
  } finally {
    await prisma.$disconnect();
  }
});

test('a diagnostic that could not execute at all (agent-side error) maintains quarantine, never clears it', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { machine } = await seedMachine(prisma, 'diag3');
    await prisma.$transaction((tx) => enterQuarantine(tx, {
      machineId: machine.id, reasonCode: 'GPU_UNAVAILABLE', reason: 'entered', source: 'test',
    }));
    const { run } = await createDiagnosticRun(prisma, { machineId: machine.id, triggeredBy: 'OWNER' });
    const outcome = await completeDiagnosticRun(prisma, {
      diagnosticRunId: run.id, machineId: machine.id, checks: [], error: 'diagnostic_container_failed', source: 'test',
    });
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.cleared, false);
    const machineRow = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
    assert.equal(machineRow.moderationStatus, ModerationStatus.QUARANTINED);
  } finally {
    await prisma.$disconnect();
  }
});

test('a second result submission for an already-completed diagnostic run is rejected as a conflict, never silently reapplied', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { machine } = await seedMachine(prisma, 'race1');
    await prisma.$transaction((tx) => enterQuarantine(tx, {
      machineId: machine.id, reasonCode: 'GPU_HEALTH_CHECK_FAILED', reason: 'entered', source: 'test',
    }));
    const { run } = await createDiagnosticRun(prisma, { machineId: machine.id, triggeredBy: 'OWNER' });
    const now = new Date();
    const checks = ['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'allocation', 'cuda', 'ram'].map((name) => ({
      name, status: 'PASS' as const, value: null, details: '', measuredAt: now.toISOString(), source: 'agent-diagnostic' as const,
    }));

    const { DiagnosticRunConflictError } = await import('../src/diagnostic-run-service.js');

    // First submission: real, wins the atomic claim (RUNNING -> COMPLETED),
    // clears the quarantine.
    const first = await completeDiagnosticRun(prisma, { diagnosticRunId: run.id, machineId: machine.id, checks, source: 'race-a', now });
    assert.equal(first.cleared, true);

    // A second submission for the same run - modeling an agent retry that never
    // saw the first response, or a replayed request - must find the run no
    // longer RUNNING and be rejected, never re-run the quarantine decision a
    // second time (which is exactly the atomic updateMany guard added to
    // diagnostic-run-service.ts's completeDiagnosticRun for this reason).
    await assert.rejects(
      () => completeDiagnosticRun(prisma, { diagnosticRunId: run.id, machineId: machine.id, checks, source: 'race-b', now }),
      DiagnosticRunConflictError,
    );

    // The quarantine must have been cleared exactly once - not left in a
    // corrupted state by two competing writers, and not cleared twice.
    const history = await prisma.machineQuarantineEvent.findMany({ where: { machineId: machine.id, status: 'CLEARED' } });
    assert.equal(history.length, 1);
  } finally {
    await prisma.$disconnect();
  }
});

test('repair never clears a quarantine by itself - a fresh diagnostic remains mandatory afterwards', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { owner, machine } = await seedMachineWithGpu(prisma, 'repair1', { moderationStatus: ModerationStatus.QUARANTINED, quarantineReasonCode: 'STALE_JOB' });
    const buyer = await prisma.user.create({ data: { wallet: 'buyer_qd_repair1', pseudonym: 'buyer_qd_repair1' } });
    const listing = await prisma.gpuListing.create({
      data: { ownerId: owner.id, machineId: machine.id, title: 't', description: 'd'.repeat(20), hourlyLamports: 1_000_000n, status: ListingStatus.PENDING_GPU_VERIFICATION, resourceMode: ListingResourceMode.FULL_MACHINE },
    });
    const booking = await prisma.booking.create({
      data: { buyerId: buyer.id, listingId: listing.id, idempotencyKey: 'idem-repair1', startsAt: new Date('2026-01-01'), endsAt: new Date('2026-01-02'), quotedLamports: 1n, expectedSeconds: 3600, status: BookingStatus.COMPLETED },
    });
    const accel = await prisma.accelerator.findFirstOrThrow({ where: { machineId: machine.id } });
    await prisma.acceleratorAllocation.create({
      data: { bookingId: booking.id, acceleratorId: accel.id, status: 'ACTIVE', startsAt: booking.startsAt, endsAt: booking.endsAt },
    });

    const available = await detectAvailableRepair(prisma, machine.id);
    assert.equal(available, 'CLEAR_ORPHANED_ALLOCATIONS');
    const result = await applyRepair(prisma, machine.id, available!);
    assert.equal(result.changed, 1);

    const machineRow = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
    assert.equal(machineRow.moderationStatus, ModerationStatus.QUARANTINED, 'repair must never itself lift a quarantine');

    const noMoreRepair = await detectAvailableRepair(prisma, machine.id);
    assert.equal(noMoreRepair, null, 'the orphan is now fixed - repair is idempotent, not repeatedly offered');
  } finally {
    await prisma.$disconnect();
  }
});

test('a quarantined machine cannot be published (createExactGpuListing fails closed with the real reason)', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { owner, machine, accelerator } = await seedMachineWithGpu(prisma, 'pub1', { moderationStatus: ModerationStatus.QUARANTINED, quarantineReasonCode: 'GPU_HEALTH_CHECK_FAILED' });
    await assert.rejects(
      () => createExactGpuListing(prisma, {
        ownerId: owner.id, machineId: machine.id, acceleratorId: accelerator.id,
        title: 'GPU quarantined', description: 'd'.repeat(20), hourlySol: 0.01,
        now: new Date(), heartbeatStaleAfterSeconds: 120,
      }),
      (error: unknown) => error instanceof RentalListingError && error.code === 'machine_not_found',
    );
  } finally {
    await prisma.$disconnect();
  }
});

test('a quarantined machine cannot be rented (allocateBookingResources fails closed)', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { owner, machine } = await seedMachine(prisma, 'rent1');
    const buyer = await prisma.user.create({ data: { wallet: 'buyer_qd_rent1', pseudonym: 'buyer_qd_rent1' } });
    const listing = await prisma.gpuListing.create({
      data: { ownerId: owner.id, machineId: machine.id, title: 't', description: 'd'.repeat(20), hourlyLamports: 1_000_000n, status: ListingStatus.ACTIVE, resourceMode: ListingResourceMode.FULL_MACHINE },
    });
    const booking = await prisma.booking.create({
      data: { buyerId: buyer.id, listingId: listing.id, idempotencyKey: 'idem-rent1', startsAt: new Date(Date.now() + 60_000), endsAt: new Date(Date.now() + 3_660_000), quotedLamports: 1n, expectedSeconds: 3600, status: BookingStatus.AWAITING_DEPOSIT },
    });
    await prisma.$transaction((tx) => enterQuarantine(tx, {
      machineId: machine.id, reasonCode: 'AGENT_SECURITY_FAILURE', reason: 'entered', source: 'test',
    }));

    await assert.rejects(
      () => allocateBookingResources(prisma, { bookingId: booking.id, buyerId: buyer.id }),
      (error: unknown) => error instanceof ResourceAllocationError && error.code === 'listing_not_available',
    );
  } finally {
    await prisma.$disconnect();
  }
});

test('end-to-end: QUARANTINED -> diagnostic -> real PASS results -> CLEAR -> publication succeeds', { skip: !hasDb }, async () => {
  const prisma = new PrismaClient();
  try {
    const { owner, machine, accelerator } = await seedMachineWithGpu(prisma, 'e2e1', { moderationStatus: ModerationStatus.QUARANTINED, quarantineReasonCode: 'GPU_HEALTH_CHECK_FAILED' });

    const blockedAttempt = await createExactGpuListing(prisma, {
      ownerId: owner.id, machineId: machine.id, acceleratorId: accelerator.id,
      title: 'still quarantined', description: 'd'.repeat(20), hourlySol: 0.01,
      now: new Date(), heartbeatStaleAfterSeconds: 120,
    }).catch((error) => error);
    assert.ok(blockedAttempt instanceof RentalListingError && blockedAttempt.code === 'machine_not_found');

    const { run } = await createDiagnosticRun(prisma, { machineId: machine.id, triggeredBy: 'OWNER' });
    const now = new Date();
    const checks = ['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'allocation', 'cuda', 'ram'].map((name) => ({
      name, status: 'PASS' as const, value: null, details: '', measuredAt: now.toISOString(), source: 'agent-diagnostic' as const,
    }));
    const outcome = await completeDiagnosticRun(prisma, { diagnosticRunId: run.id, machineId: machine.id, checks, source: 'test', now });
    assert.equal(outcome.cleared, true);

    const acceleratorRow = await prisma.accelerator.findUniqueOrThrow({ where: { id: accelerator.id } });
    assert.equal(acceleratorRow.moderationStatus, ModerationStatus.CLEAR, 'Machine/Accelerator must never disagree after a clear');

    const listing = await createExactGpuListing(prisma, {
      ownerId: owner.id, machineId: machine.id, acceleratorId: accelerator.id,
      title: 'healthy again', description: 'd'.repeat(20), hourlySol: 0.01,
      now: new Date(), heartbeatStaleAfterSeconds: 120,
    });
    assert.equal(listing.status, ListingStatus.ACTIVE);

    // Cas 3 (point 17 du chantier) : la machine redevient problématique -> une
    // nouvelle preuve FAIL doit la refaire basculer automatiquement, et la
    // publication doit redevenir impossible.
    const { run: secondRun } = await createDiagnosticRun(prisma, { machineId: machine.id, triggeredBy: 'SYSTEM' });
    const secondNow = new Date(now.getTime() + 60_000);
    const failingChecks = checks.map((c) => (c.name === 'gpu' ? { ...c, status: 'FAIL' as const } : c));
    const secondOutcome = await completeDiagnosticRun(prisma, {
      diagnosticRunId: secondRun.id, machineId: machine.id, checks: failingChecks, source: 'test', now: secondNow,
    });
    assert.equal(secondOutcome.cleared, false);
    const reQuarantinedMachine = await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
    assert.equal(reQuarantinedMachine.moderationStatus, ModerationStatus.QUARANTINED);
    assert.equal(reQuarantinedMachine.quarantineReasonCode, 'GPU_UNAVAILABLE');

    const secondListingAttempt = await createExactGpuListing(prisma, {
      ownerId: owner.id, machineId: machine.id, acceleratorId: accelerator.id,
      title: 'problematic again', description: 'd'.repeat(20), hourlySol: 0.01,
      now: new Date(), heartbeatStaleAfterSeconds: 120,
    }).catch((error) => error);
    assert.ok(secondListingAttempt instanceof RentalListingError && secondListingAttempt.code === 'machine_not_found', 'publication must be blocked again automatically');

    // Seeding this test set moderationStatus=QUARANTINED directly (bypassing
    // enterQuarantine, which is not itself under test here), so history starts
    // from the first real diagnostic, not an ENTERED row.
    const fullHistory = await prisma.machineQuarantineEvent.findMany({ where: { machineId: machine.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(fullHistory.map((e) => e.status), ['DIAGNOSTIC', 'CLEARED', 'DIAGNOSTIC', 'ENTERED'], 'the full lifecycle must be visible, in order, with nothing overwritten');
  } finally {
    await prisma.$disconnect();
  }
});

test('a stale machine (30+ days without a heartbeat) is identified as STALE, distinct from a merely offline one', () => {
  const now = new Date('2026-09-01T00:00:00Z');
  assert.equal(computeLifecycleStatus({ lifecycleStatus: 'ACTIVE', lastHeartbeatAt: new Date('2026-08-30T00:00:00Z') }, now), 'OFFLINE');
  assert.equal(computeLifecycleStatus({ lifecycleStatus: 'ACTIVE', lastHeartbeatAt: new Date('2026-07-01T00:00:00Z') }, now), 'STALE');
  assert.equal(computeLifecycleStatus({ lifecycleStatus: 'ACTIVE', lastHeartbeatAt: now }, now), 'ACTIVE');
  assert.equal(computeLifecycleStatus({ lifecycleStatus: 'RETIRED', lastHeartbeatAt: now }, now), 'RETIRED', 'an explicit retirement is never overridden by fresh heartbeat math');
  assert.equal(computeLifecycleStatus({ lifecycleStatus: 'ACTIVE', lastHeartbeatAt: null }, now), 'OFFLINE');
});

test('the agent challenge endpoint no longer requires moderationStatus CLEAR (a quarantined machine must still authenticate to run its diagnostic)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/agent/challenge/:machineId'");
  const end = source.indexOf('\napp.', start + 1);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /moderationStatus!==ModerationStatus\.CLEAR/, 'the challenge route must not gate on moderationStatus');
  assert.match(body, /keyRevokedAt/, 'a revoked key must still be rejected');
});
