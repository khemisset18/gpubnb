import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import { requireSession } from './auth.js';
import { config } from './config.js';
import { evaluateWorkspaceAccess } from './workspace-access-policy.js';
import { issueWorkspaceAccessGrant } from './workspace-access.js';

function safeConnection(metadata: unknown): { ready: boolean; gatewayPath: string | null } {
  if (!metadata || typeof metadata !== 'object') return { ready: false, gatewayPath: null };
  const value = metadata as Record<string, unknown>;
  const path = typeof value.gatewayPath === 'string' ? value.gatewayPath : null;
  // Interactive traffic must enter through GPUbnb. Never return arbitrary host URLs/IPs.
  if (!path || !path.startsWith('/workspace-gateway/') || path.includes('..')) return { ready: false, gatewayPath: null };
  return { ready: true, gatewayPath: path };
}

export function registerWorkspaceRenterRoutes(app: FastifyInstance, db: PrismaClient, redis: Redis): void {
  app.get('/bookings/:bookingId/workspace', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId },
      select: {
        id: true, status: true, expiresAt: true, preparationProgress: true, preparationStep: true,
        connectionType: true, connectionMetadata: true, readyAt: true, startedAt: true,
        machine: { select: { gpuModel: true, vramMiB: true, connectivity: true, operational: true, moderationStatus: true, lastHeartbeatAt: true } },
        booking: { select: { id: true, status: true, startsAt: true, endsAt: true } },
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
      heartbeatMaxAgeSeconds: config.HEARTBEAT_MAX_AGE_SECONDS,
    });
    const connection = safeConnection(row.connectionMetadata);
    return {
      sessionId: row.id,
      status: row.status,
      workspace: row.machineWorkspace.workspace,
      gpu: { model: row.machine.gpuModel, vramMiB: row.machine.vramMiB },
      startsAt: row.booking.startsAt,
      endsAt: row.booking.endsAt,
      expiresAt: row.expiresAt,
      preparation: { progress: row.preparationProgress, step: row.preparationStep },
      canOpen: policy.allowed && connection.ready,
      blockedReason: !policy.allowed ? policy.code : connection.ready ? null : 'GATEWAY_NOT_READY',
    };
  });

  app.post('/bookings/:bookingId/workspace/access', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const bookingId = String((request.params as { bookingId?: string }).bookingId || '');
    const row = await db.workspaceSession.findFirst({
      where: { bookingId, renterId: session.userId },
      select: {
        id: true, renterId: true, status: true, expiresAt: true, connectionMetadata: true,
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
      heartbeatMaxAgeSeconds: config.HEARTBEAT_MAX_AGE_SECONDS,
    });
    if (!policy.allowed) return reply.code(409).send({ error: policy.code.toLowerCase() });
    const connection = safeConnection(row.connectionMetadata);
    if (!connection.ready || !connection.gatewayPath) return reply.code(409).send({ error: 'workspace_gateway_not_ready' });
    const grant = await issueWorkspaceAccessGrant(redis, { userId: session.userId, bookingId, sessionId: row.id });
    return { ...grant, openPath: `${connection.gatewayPath}?grant=${encodeURIComponent(grant.token)}` };
  });
}
