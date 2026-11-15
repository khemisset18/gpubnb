/**
 * Four desktop streaming workspaces share the existing renter authorization
 * and Gateway. Lab-only routes: never register in production.
 */
import type { FastifyInstance } from 'fastify';
import { BookingStatus, JobStatus, JobType, Prisma, WorkspaceSessionStatus, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { requireSession } from './auth.js';
import { config } from './config.js';
import { desktopWorkspacePreviewEnabled, desktopWorkspaceSlugs } from './desktop-workspace-preview.js';
import { ensureCompatibleMachineWorkspace } from './machine-workspace-catalog.js';
import { runBookingTransaction } from './booking-transaction-retry.js';
import { evaluateWorkspaceAccess } from './workspace-access-policy.js';
import { issueWorkspaceAccessGrant } from './workspace-access.js';
import { isWorkspaceGatewayLive } from './workspace-gateway-liveness.js';

const ACTIVE_BOOKINGS = [BookingStatus.FUNDED, BookingStatus.STARTING, BookingStatus.ACTIVE];
const RETRYABLE = [WorkspaceSessionStatus.FAILED, WorkspaceSessionStatus.CANCELLED, WorkspaceSessionStatus.TIMED_OUT];
const TERMINAL_JOBS = [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED, JobStatus.TIMED_OUT, JobStatus.REJECTED, JobStatus.QUARANTINED];
class BookingIneligible extends Error {}
class DesktopAlreadySelected extends Error {}

function connectionInfo(metadata: unknown): { ready: boolean; gatewayPath: string | null } {
  if (!metadata || typeof metadata !== 'object') return { ready: false, gatewayPath: null };
  const path = (metadata as Record<string, unknown>).gatewayPath;
  if (typeof path !== 'string' || !/^\/workspace-gateway\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_./-]*)?$/.test(path) || path.includes('..')) {
    return { ready: false, gatewayPath: null };
  }
  return { ready: true, gatewayPath: path };
}
function sessionPolicy(authenticatedUserId: string, row: {
  renterId: string; booking: { status: BookingStatus }; status: WorkspaceSessionStatus;
  expiresAt: Date; machine: {
    connectivity: any; operational: any; moderationStatus: any; lastHeartbeatAt: Date | null;
  };
}) {
  return evaluateWorkspaceAccess({
    authenticatedUserId, renterId: row.renterId, bookingStatus: row.booking.status,
    sessionStatus: row.status, expiresAt: row.expiresAt,
    machineConnectivity: row.machine.connectivity,
    machineOperational: row.machine.operational,
    moderationStatus: row.machine.moderationStatus,
    lastHeartbeatAt: row.machine.lastHeartbeatAt,
    heartbeatMaxAgeSeconds: config.WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS,
  });
}

/** Called after the ordinary routes; only explicitly enabled test environments get these endpoints. */
export function registerDesktopWorkspaceRenterRoutes(app: FastifyInstance, db: PrismaClient, redis: Redis): void {
  app.get('/workspaces/desktop-preview-availability', async () => ({
    enabled: desktopWorkspacePreviewEnabled(),
    slugs: desktopWorkspacePreviewEnabled() ? [...desktopWorkspaceSlugs] : [],
  }));
  if (!desktopWorkspacePreviewEnabled()) return;

  for (const slug of desktopWorkspaceSlugs) {
    const base = '/bookings/:bookingId/workspace/' + slug;
    app.post(base, async (request, reply) => {
      const auth = await requireSession(request, reply, redis);
      if (!auth) return;
      const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
      const booking = await db.booking.findFirst({
        where: { id: bookingId, buyerId: auth.userId, status: { in: ACTIVE_BOOKINGS }, endsAt: { gt: new Date() } },
        include: { listing: { select: { machineId: true } } },
      });
      if (!booking) return reply.code(409).send({ error: 'funded_booking_required' });
      let machineWorkspace;
      try { machineWorkspace = await ensureCompatibleMachineWorkspace(db, booking.listing.machineId, slug); }
      catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'workspace_incompatible' }); }
      const existing = await db.workspaceSession.findFirst({
        where: { bookingId, renterId: auth.userId, machineWorkspaceId: machineWorkspace.id },
        select: { id: true, status: true },
      });
      if (existing) return existing;
      try {
        return await runBookingTransaction(db, async tx => {
          // Serialize different-slug requests on the same booking row.
          const locked = await tx.booking.updateMany({
            where: { id: bookingId, buyerId: auth.userId, status: { in: ACTIVE_BOOKINGS }, endsAt: { gt: new Date() } },
            data: { buyerId: auth.userId },
          });
          if (locked.count !== 1) throw new BookingIneligible();
          // A booking can carry its automatic Compute proof, but not two desktop
          // surfaces sharing a single rented GPU. Includes stopped desktop sessions:
          // switching profiles requires a new booking and cleaned resources.
          const another = await tx.workspaceSession.findFirst({
            where: { bookingId, machineWorkspace: { workspace: { slug: { in: [...desktopWorkspaceSlugs] } } } },
            select: { id: true, machineWorkspaceId: true },
          });
          if (another) {
            if (another.machineWorkspaceId !== machineWorkspace.id) throw new DesktopAlreadySelected();
            const raced = await tx.workspaceSession.findUnique({ where: { id: another.id }, select: { id: true, status: true } });
            if (raced) return raced;
          }
          const created = await tx.workspaceSession.create({
            data: {
              bookingId, renterId: auth.userId, machineId: booking.listing.machineId, machineWorkspaceId: machineWorkspace.id,
              status: WorkspaceSessionStatus.PREPARING, isolationType: 'DOCKER',
              resourceLimits: {
                maxRamMiB: slug === 'cloud-desktop' ? 4096 : 8192,
                maxCpuCores: slug === 'cloud-desktop' ? 2 : 4,
                storageQuotaMiB: slug === 'gaming' ? 102400 : 40960,
                networkAccess: 'RESTRICTED', autoStopMinutes: 60,
              },
              connectionType: 'GPUBNB_GATEWAY', preparationProgress: 5,
              preparationStep: 'DESKTOP_PREVIEW_REQUESTED', preparationRequestedAt: new Date(),
              readyDeadlineAt: new Date(Math.max(Date.now(), booking.startsAt.getTime() - 120_000)),
              expiresAt: booking.endsAt,
              events: { create: { actorType: 'RENTER', actorId: auth.userId, action: 'DESKTOP_PREPARATION_REQUESTED' } },
            },
          });
          const job = await tx.job.create({
            data: { bookingId, renterId: auth.userId, machineId: booking.listing.machineId,
              type: JobType.WORKSPACE_PREPARE, parameters: { workspaceSlug: slug, timeoutSeconds: 1800 } },
          });
          return tx.workspaceSession.update({
            where: { id: created.id },
            data: { jobId: job.id, preparationAttempts: { increment: 1 } },
            select: { id: true, status: true, preparationProgress: true, preparationStep: true },
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
      } catch (error) {
        if (error instanceof BookingIneligible) return reply.code(409).send({ error: 'funded_booking_required' });
        if (error instanceof DesktopAlreadySelected) return reply.code(409).send({ error: 'desktop_workspace_already_selected' });
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const raced = await db.workspaceSession.findFirst({
            where: { bookingId, renterId: auth.userId, machineWorkspaceId: machineWorkspace.id },
            select: { id: true, status: true },
          });
          if (raced) return raced;
        }
        throw error;
      }
    });

    app.get(base + '/status', async (request, reply) => {
      const auth = await requireSession(request, reply, redis);
      if (!auth) return;
      const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
      const row = await db.workspaceSession.findFirst({
        where: { bookingId, renterId: auth.userId, machineWorkspace: { workspace: { slug } } },
        select: {
          id: true, renterId: true, status: true, expiresAt: true, preparationProgress: true,
          preparationStep: true, preparationAttempts: true, preparationRequestedAt: true,
          preparationStartedAt: true, preparationCompletedAt: true, endedAt: true, updatedAt: true,
          connectionMetadata: true, gatewayLastSeenAt: true,
          job: { select: { status: true, errorCode: true, createdAt: true, updatedAt: true, finishedAt: true } },
          machine: { select: { gpuModel: true, vramMiB: true, connectivity: true, operational: true, moderationStatus: true, lastHeartbeatAt: true } },
          booking: { select: { status: true, startsAt: true, endsAt: true } },
          machineWorkspace: { select: { workspace: { select: { slug: true, name: true } } } },
        },
      });
      if (!row) return reply.code(404).send({ error: 'workspace_session_not_found' });
      const policy = sessionPolicy(auth.userId, row);
      const connection = connectionInfo(row.connectionMetadata);
      const gatewayLive = isWorkspaceGatewayLive(row.gatewayLastSeenAt);
      const started = row.preparationStartedAt ?? row.preparationRequestedAt ?? row.job?.createdAt ?? row.updatedAt;
      const finished = row.preparationCompletedAt ?? row.endedAt ?? row.job?.finishedAt ?? new Date();
      return {
        sessionId: row.id, workspace: row.machineWorkspace.workspace, status: row.status,
        gpu: { model: row.machine.gpuModel, vramMiB: row.machine.vramMiB },
        startsAt: row.booking.startsAt, endsAt: row.booking.endsAt, expiresAt: row.expiresAt,
        preparation: {
          progress: row.preparationProgress, step: row.preparationStep,
          phase: row.status === WorkspaceSessionStatus.READY && !(connection.ready && gatewayLive)
            ? 'GATEWAY_NOT_READY' : row.status,
          attempts: row.preparationAttempts,
          elapsedSeconds: Math.max(0, Math.round((finished.getTime() - started.getTime()) / 1000)),
          updatedAt: row.job?.updatedAt ?? row.updatedAt,
          jobStatus: row.job?.status ?? null, errorCode: row.job?.errorCode ?? null,
        },
        retryable: ACTIVE_BOOKINGS.includes(row.booking.status) && RETRYABLE.includes(row.status),
        canOpen: policy.allowed && connection.ready && gatewayLive,
        blockedReason: !policy.allowed ? policy.code : !connection.ready ? 'GATEWAY_NOT_READY'
          : gatewayLive ? null : 'GATEWAY_STALE',
      };
    });

    app.post(base + '/access', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      const auth = await requireSession(request, reply, redis);
      if (!auth) return;
      const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
      const row = await db.workspaceSession.findFirst({
        where: { bookingId, renterId: auth.userId, machineWorkspace: { workspace: { slug } } },
        select: {
          id: true, renterId: true, status: true, expiresAt: true, connectionMetadata: true, gatewayLastSeenAt: true,
          machine: { select: { connectivity: true, operational: true, moderationStatus: true, lastHeartbeatAt: true } },
          booking: { select: { status: true } },
        },
      });
      if (!row) return reply.code(404).send({ error: 'workspace_session_not_found' });
      const policy = sessionPolicy(auth.userId, row);
      if (!policy.allowed) return reply.code(409).send({ error: policy.code.toLowerCase() });
      const connection = connectionInfo(row.connectionMetadata);
      if (!connection.ready || !connection.gatewayPath || !isWorkspaceGatewayLive(row.gatewayLastSeenAt)) {
        return reply.code(409).send({ error: 'workspace_gateway_not_ready' });
      }
      const grant = await issueWorkspaceAccessGrant(redis, { userId: auth.userId, bookingId, sessionId: row.id, requestId: request.id });
      return { ...grant, openPath: connection.gatewayPath + '?grant=' + encodeURIComponent(grant.token) };
    });

    app.post(base + '/retry', async (request, reply) => {
      const auth = await requireSession(request, reply, redis);
      if (!auth) return;
      const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
      const row = await db.workspaceSession.findFirst({
        where: { bookingId, renterId: auth.userId, status: { in: RETRYABLE },
          machineWorkspace: { workspace: { slug } },
          booking: { status: { in: ACTIVE_BOOKINGS }, endsAt: { gt: new Date() } } },
        select: { id: true, machineId: true, booking: { select: { endsAt: true } } },
      });
      if (!row) return reply.code(409).send({ error: 'workspace_retry_not_available' });
      const active = await db.job.findFirst({
        where: { bookingId, type: JobType.WORKSPACE_PREPARE, status: { notIn: TERMINAL_JOBS } },
        select: { id: true },
      });
      if (active) return reply.code(409).send({ error: 'workspace_preparation_already_active', jobId: active.id });
      const retried = await runBookingTransaction(db, async tx => {
        const locked = await tx.booking.updateMany({
          where: { id: bookingId, buyerId: auth.userId, status: { in: ACTIVE_BOOKINGS }, endsAt: { gt: new Date() } },
          data: { buyerId: auth.userId },
        });
        if (locked.count !== 1) return null;
        const reset = await tx.workspaceSession.updateMany({
          where: { id: row.id, status: { in: RETRYABLE } },
          data: {
            status: WorkspaceSessionStatus.PREPARING, jobId: null, endedAt: null, terminationReason: null,
            readyAt: null, startedAt: null, connectionMetadata: {}, gatewayLastSeenAt: null,
            preparationProgress: 5, preparationStep: 'RETRY_REQUESTED',
            preparationRequestedAt: new Date(), preparationStartedAt: null, preparationCompletedAt: null,
            preparationAttempts: { increment: 1 }, expiresAt: row.booking.endsAt,
          },
        });
        if (reset.count !== 1) return null;
        const job = await tx.job.create({
          data: { bookingId, renterId: auth.userId, machineId: row.machineId,
            type: JobType.WORKSPACE_PREPARE, parameters: { workspaceSlug: slug, timeoutSeconds: 1800 } },
        });
        return tx.workspaceSession.update({
          where: { id: row.id },
          data: { jobId: job.id, events: { create: { actorType: 'RENTER', actorId: auth.userId, action: 'DESKTOP_PREPARATION_RETRIED' } } },
          select: { id: true, status: true, preparationProgress: true, preparationStep: true },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
      return retried ?? reply.code(409).send({ error: 'workspace_retry_raced' });
    });
  }
}
