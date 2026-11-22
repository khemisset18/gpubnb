import { BookingStatus, MachineConnectivity, MachineOperational, MachineWorkspaceState, ModerationStatus, PrismaClient, WorkspaceRelease, WorkspaceSessionStatus } from '@prisma/client';
import { workspaceManifest } from '../../src/workspace-manifests.js';

export async function seedReadySession(prisma: PrismaClient, suffix: string, options: {
  bookingStatus: BookingStatus;
  expectedSeconds: number;
  bookingStartsAt?: Date;
  bookingEndsAt?: Date;
  workspaceActivatedAt?: Date | null;
}) {
  // This helper seeds database-only gateway fixtures. It deliberately does not
  // call ensureCompatibleMachineWorkspace(), which is a production capability
  // gate and must remain closed for Windows until a native runtime is qualified.
  // No Agent, desktop, container, or Workspace process is launched by this fixture.
  const now = new Date();
  const owner = await prisma.user.create({ data: { wallet: `owner_act_${suffix}`, pseudonym: `owner_act_${suffix}`, canHost: true } });
  const renter = await prisma.user.create({ data: { wallet: `renter_act_${suffix}`, pseudonym: `renter_act_${suffix}` } });
  const machine = await prisma.machine.create({
    data: {
      ownerId: owner.id,
      agentPublicKey: `agentkey_act_${suffix}`,
      operatingSystem: 'Windows 11',
      connectivity: MachineConnectivity.ONLINE,
      operational: MachineOperational.RESERVED,
      moderationStatus: ModerationStatus.CLEAR,
      lastHeartbeatAt: now,
      verifiedAt: now,
      ramTotalMiB: 16_384,
      diskTotalMiB: 51_200,
    },
  });
  const manifest = workspaceManifest('cloud-desktop');
  if (!manifest) throw new Error('test_fixture_workspace_manifest_missing');
  const definition = await prisma.workspaceDefinition.upsert({
    where: { slug: manifest.slug },
    update: {
      version: 1,
      name: manifest.name,
      category: manifest.category,
      release: manifest.release as WorkspaceRelease,
      manifest: JSON.parse(JSON.stringify(manifest)),
    },
    create: {
      slug: manifest.slug,
      version: 1,
      name: manifest.name,
      category: manifest.category,
      release: manifest.release as WorkspaceRelease,
      manifest: JSON.parse(JSON.stringify(manifest)),
    },
  });
  const fixtureAnalysis = {
    fixtureOnly: true,
    runtimeBackend: 'WINDOWS_NATIVE',
    runtimeStarted: false,
    validation: 'database-only-gateway-contract',
  };
  const machineWorkspace = await prisma.machineWorkspace.upsert({
    where: { machineId_workspaceId: { machineId: machine.id, workspaceId: definition.id } },
    update: {
      compatibilityScore: 100,
      state: MachineWorkspaceState.READY,
      analysis: fixtureAnalysis,
      analyzedAt: now,
    },
    create: {
      machineId: machine.id,
      workspaceId: definition.id,
      compatibilityScore: 100,
      state: MachineWorkspaceState.READY,
      analysis: fixtureAnalysis,
    },
  });
  const listing = await prisma.gpuListing.create({
    data: {
      ownerId: owner.id, machineId: machine.id,
      title: `activation test listing ${suffix}`, description: 'Seeded by workspace-activation-timer.test.ts',
      hourlyLamports: 1_000_000n, status: 'ACTIVE',
    },
  });
  const bookingStartsAt = options.bookingStartsAt ?? now;
  const bookingEndsAt = options.bookingEndsAt ?? new Date(now.getTime() + 3_600_000);
  const booking = await prisma.booking.create({
    data: {
      buyerId: renter.id, listingId: listing.id, idempotencyKey: `idem_act_${suffix}`,
      startsAt: bookingStartsAt, endsAt: bookingEndsAt,
      quotedLamports: 1_000_000n, expectedSeconds: options.expectedSeconds,
      status: options.bookingStatus,
      ...(options.workspaceActivatedAt !== undefined ? { workspaceActivatedAt: options.workspaceActivatedAt } : {}),
    },
  });
  await prisma.machineAllocation.create({
    data: { bookingId: booking.id, machineId: machine.id, status: 'ACTIVE', startsAt: bookingStartsAt, endsAt: bookingEndsAt },
  });
  const job = await prisma.job.create({
    data: {
      bookingId: booking.id, renterId: renter.id, machineId: machine.id,
      type: 'WORKSPACE_PREPARE', parameters: { workspaceSlug: manifest.slug, timeoutSeconds: 1200 },
      status: 'COMPLETED', finishedAt: now,
    },
  });
  const session = await prisma.workspaceSession.create({
    data: {
      bookingId: booking.id, renterId: renter.id, machineId: machine.id,
      machineWorkspaceId: machineWorkspace.id, jobId: job.id,
      status: WorkspaceSessionStatus.READY, isolationType: 'WINDOWS_SESSION', runtimeBackend: 'WINDOWS_NATIVE',
      resourceLimits: { maxRamMiB: 4096, maxCpuCores: 2, storageQuotaMiB: 10240, networkAccess: 'RESTRICTED', autoStopMinutes: 60 },
      connectionType: 'GPUBNB_GATEWAY', connectionMetadata: { gatewayPath: `/workspace-gateway/placeholder` },
      preparationProgress: 100, preparationStep: 'CONNECTION_READY',
      readyAt: now, expiresAt: bookingEndsAt,
    },
  });
  return {
    owner, renter, machine, listing, booking, session,
    async cleanup() {
      await prisma.workspaceSessionEvent.deleteMany({ where: { sessionId: session.id } }).catch(() => {});
      await prisma.workspaceSession.deleteMany({ where: { id: session.id } }).catch(() => {});
      await prisma.job.deleteMany({ where: { id: job.id } }).catch(() => {});
      await prisma.machineAllocation.deleteMany({ where: { bookingId: booking.id } }).catch(() => {});
      await prisma.booking.deleteMany({ where: { id: booking.id } }).catch(() => {});
      await prisma.machineWorkspace.deleteMany({ where: { machineId: machine.id } }).catch(() => {});
      await prisma.gpuListing.delete({ where: { id: listing.id } }).catch(() => {});
      await prisma.machine.delete({ where: { id: machine.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: renter.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
    },
  };
}
