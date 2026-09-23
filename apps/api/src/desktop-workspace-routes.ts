import type { FastifyInstance } from 'fastify';
import { BookingStatus, JobType, Prisma, WorkspaceRuntimeBackend, WorkspaceSessionStatus, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import { requireSession } from './auth.js';
import { config } from './config.js';
import { ensureCompatibleMachineWorkspace, type ExecutableWorkspaceSlug } from './machine-workspace-catalog.js';
import { evaluateWorkspaceAccess } from './workspace-access-policy.js';
import { issueWorkspaceAccessGrant } from './workspace-access.js';
import { isWorkspaceGatewayLive } from './workspace-gateway-liveness.js';
import { preparationPhase, safeConnection } from './workspace-renter-routes.js';

const desktopWorkspaceSlugs = ['cloud-desktop', 'creator', 'cad', 'gaming'] as const;
type DesktopWorkspaceSlug = typeof desktopWorkspaceSlugs[number];

const activeBookings: BookingStatus[] = [BookingStatus.FUNDED, BookingStatus.STARTING, BookingStatus.ACTIVE];

const workspaceSpec: Record<DesktopWorkspaceSlug, {
  requestedStep: string;
  requestedEvent: string;
  timeoutSeconds: number;
  maxRamMiB: number;
  maxCpuCores: number;
  storageQuotaMiB: number;
}> = {
  'cloud-desktop': {
    requestedStep: 'CLOUD_DESKTOP_REQUESTED',
    requestedEvent: 'CLOUD_DESKTOP_PREPARATION_REQUESTED',
    timeoutSeconds: 1800,
    maxRamMiB: 8192,
    maxCpuCores: 4,
    storageQuotaMiB: 81920,
  },
  creator: {
    requestedStep: 'CREATOR_REQUESTED',
    requestedEvent: 'CREATOR_PREPARATION_REQUESTED',
    timeoutSeconds: 1800,
    maxRamMiB: 16384,
    maxCpuCores: 4,
    storageQuotaMiB: 102400,
  },
  cad: {
    requestedStep: 'CAD_REQUESTED',
    requestedEvent: 'CAD_PREPARATION_REQUESTED',
    timeoutSeconds: 1800,
    maxRamMiB: 16384,
    maxCpuCores: 4,
    storageQuotaMiB: 122880,
  },
  gaming: {
    requestedStep: 'GAMING_REQUESTED',
    requestedEvent: 'GAMING_PREPARATION_REQUESTED',
    timeoutSeconds: 1800,
    maxRamMiB: 16384,
    maxCpuCores: 4,
    storageQuotaMiB: 204800,
  },
};

function executableSlug(slug: DesktopWorkspaceSlug): ExecutableWorkspaceSlug {
  return slug;
}

async function createDesktopWorkspaceSession(
  db: PrismaClient,
  bookingId: string,
  renterId: string,
  slug: DesktopWorkspaceSlug,
) {
  const booking = await db.booking.findFirst({
    where: { id: bookingId, buyerId: renterId, status: { in: activeBookings } },
    include: { listing: { select: { machineId: true } } },
  });
  if (!booking) return { error: 'funded_booking_required' as const };

  let machineWorkspace;
  try {
    machineWorkspace = await ensureCompatibleMachineWorkspace(db, booking.listing.machineId, executableSlug(slug));
  } catch (error) {
    return { error: error instanceof Error ? error.message : `${slug}_workspace_incompatible` };
  }

  const existing = await db.workspaceSession.findFirst({
    where: { bookingId, renterId, machineWorkspaceId: machineWorkspace.id },
    select: { id: true, status: true, preparationProgress: true, preparationStep: true },
  });
  if (existing) return { session: existing };

  const spec = workspaceSpec[slug];
  try {
    const session = await db.$transaction(async (tx) => {
      // Same race boundary as the already-qualified renter routes: re-check the
      // commercial booking inside the transaction before creating a runtime.
      const eligible = await tx.booking.updateMany({
        where: { id: bookingId, buyerId: renterId, status: { in: activeBookings }, endsAt: { gt: new Date() } },
        data: { buyerId: renterId },
      });
      if (eligible.count !== 1) throw new Error('funded_booking_required');

      const created = await tx.workspaceSession.create({
        data: {
          bookingId,
          renterId,
          machineId: booking.listing.machineId,
          machineWorkspaceId: machineWorkspace.id,
          status: WorkspaceSessionStatus.PREPARING,
          isolationType: 'DOCKER',
          runtimeBackend: WorkspaceRuntimeBackend.CONTAINER,
          resourceLimits: {
            maxRamMiB: spec.maxRamMiB,
            maxCpuCores: spec.maxCpuCores,
            storageQuotaMiB: spec.storageQuotaMiB,
            networkAccess: 'RESTRICTED',
            autoStopMinutes: 60,
          },
          connectionType: 'GPUBNB_GATEWAY',
          preparationProgress: 5,
          preparationStep: spec.requestedStep,
          preparationRequestedAt: new Date(),
          readyDeadlineAt: new Date(Math.max(Date.now(), booking.startsAt.getTime() - 120_000)),
          expiresAt: booking.endsAt,
          events: {
            create: { actorType: 'RENTER', actorId: renterId, action: spec.requestedEvent },
          },
        },
      });

      const job = await tx.job.create({
        data: {
          bookingId,
          renterId,
          machineId: booking.listing.machineId,
          type: JobType.WORKSPACE_PREPARE,
          parameters: { workspaceSlug: slug, timeoutSeconds: spec.timeoutSeconds },
        },
      });

      return tx.workspaceSession.update({
        where: { id: created.id },
        data: { jobId: job.id, preparationAttempts: { increment: 1 } },
        select: { id: true, status: true, preparationProgress: true, preparationStep: true },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
    return { session };
  } catch (error) {
    const raced = await db.workspaceSession.findFirst({
      where: { bookingId, renterId, machineWorkspaceId: machineWorkspace.id },
      select: { id: true, status: true, preparationProgress: true, preparationStep: true },
    });
    if (raced) return { session: raced };
    if (error instanceof Error && error.message === 'funded_booking_required') return { error: error.message };
    throw error;
  }
}

export function registerDesktopWorkspaceRoutes(app: FastifyInstance, db: PrismaClient, redis: Redis): void {
  for (const slug of desktopWorkspaceSlugs) {
    app.post(`/bookings/:bookingId/workspace/${slug}`, async (request, reply) => {
      const session = await requireSession(request, reply, redis);
      if (!session) return;
      const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
      const result = await createDesktopWorkspaceSession(db, bookingId, session.userId, slug);
      if ('error' in result) return reply.code(409).send({ error: result.error });
      return result.session;
    });

    app.get(`/bookings/:bookingId/workspace/${slug}/status`, async (request, reply) => {
      const session = await requireSession(request, reply, redis);
      if (!session) return;
      const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
      const row = await db.workspaceSession.findFirst({
        where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug } } },
        select: {
          id: true,
          status: true,
          expiresAt: true,
          preparationProgress: true,
          preparationStep: true,
          preparationAttempts: true,
          preparationRequestedAt: true,
          preparationStartedAt: true,
          preparationCompletedAt: true,
          endedAt: true,
          updatedAt: true,
          connectionMetadata: true,
          gatewayLastSeenAt: true,
          job: { select: { status: true, errorCode: true, createdAt: true, updatedAt: true, finishedAt: true } },
          machine: { select: { gpuModel: true, vramMiB: true, connectivity: true, operational: true, moderationStatus: true, lastHeartbeatAt: true } },
          booking: { select: { status: true, startsAt: true, endsAt: true } },
          machineWorkspace: { select: { workspace: { select: { slug: true, name: true } } } },
        },
      });
      if (!row) return reply.code(404).send({ error: 'workspace_session_not_found' });

      const policy = evaluateWorkspaceAccess({
        authenticatedUserId: session.userId,
        renterId: session.userId,
        bookingStatus: row.booking.status,
        sessionStatus: row.status,
        expiresAt: row.expiresAt,
        machineConnectivity: row.machine.connectivity,
        machineOperational: row.machine.operational,
        moderationStatus: row.machine.moderationStatus,
        lastHeartbeatAt: row.machine.lastHeartbeatAt,
        heartbeatMaxAgeSeconds: config.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS,
      });
      const connection = safeConnection(row.connectionMetadata);
      const live = connection.ready && isWorkspaceGatewayLive(row.gatewayLastSeenAt);
      const phase = preparationPhase(row.status, row.preparationStep, row.job?.status ?? null, live);
      const preparationStart = row.preparationStartedAt ?? row.preparationRequestedAt ?? row.job?.createdAt ?? row.updatedAt;
      const preparationEnd = row.preparationCompletedAt ?? row.endedAt ?? row.job?.finishedAt ?? new Date();

      return {
        sessionId: row.id,
        status: row.status,
        workspace: row.machineWorkspace.workspace,
        gpu: { model: row.machine.gpuModel, vramMiB: row.machine.vramMiB },
        startsAt: row.booking.startsAt,
        endsAt: row.booking.endsAt,
        expiresAt: row.expiresAt,
        preparation: {
          progress: row.preparationProgress,
          step: row.preparationStep,
          phase,
          attempts: row.preparationAttempts,
          elapsedSeconds: Math.max(0, Math.round((preparationEnd.getTime() - preparationStart.getTime()) / 1000)),
          updatedAt: row.job?.updatedAt ?? row.updatedAt,
          jobStatus: row.job?.status ?? null,
          errorCode: row.job?.errorCode ?? null,
        },
        canOpen: policy.allowed && live,
        blockedReason: !policy.allowed ? policy.code : !connection.ready ? 'GATEWAY_NOT_READY' : live ? null : 'GATEWAY_STALE',
      };
    });

    app.post(`/bookings/:bookingId/workspace/${slug}/access`, {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const session = await requireSession(request, reply, redis);
      if (!session) return;
      const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
      const row = await db.workspaceSession.findFirst({
        where: { bookingId, renterId: session.userId, machineWorkspace: { workspace: { slug } } },
        select: {
          id: true,
          renterId: true,
          status: true,
          expiresAt: true,
          connectionMetadata: true,
          gatewayLastSeenAt: true,
          machine: { select: { connectivity: true, operational: true, moderationStatus: true, lastHeartbeatAt: true } },
          booking: { select: { status: true } },
        },
      });
      if (!row) return reply.code(404).send({ error: 'workspace_session_not_found' });

      const policy = evaluateWorkspaceAccess({
        authenticatedUserId: session.userId,
        renterId: row.renterId,
        bookingStatus: row.booking.status,
        sessionStatus: row.status,
        expiresAt: row.expiresAt,
        machineConnectivity: row.machine.connectivity,
        machineOperational: row.machine.operational,
        moderationStatus: row.machine.moderationStatus,
        lastHeartbeatAt: row.machine.lastHeartbeatAt,
        heartbeatMaxAgeSeconds: config.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS,
      });
      if (!policy.allowed) return reply.code(409).send({ error: policy.code.toLowerCase() });
      const connection = safeConnection(row.connectionMetadata);
      if (!connection.ready || !connection.gatewayPath || !isWorkspaceGatewayLive(row.gatewayLastSeenAt)) {
        return reply.code(409).send({ error: 'workspace_gateway_not_ready' });
      }
      const grant = await issueWorkspaceAccessGrant(redis, {
        userId: session.userId,
        bookingId,
        sessionId: row.id,
        requestId: request.id,
      });
      return { ...grant, openPath: `${connection.gatewayPath}?grant=${encodeURIComponent(grant.token)}` };
    });
  }
}
