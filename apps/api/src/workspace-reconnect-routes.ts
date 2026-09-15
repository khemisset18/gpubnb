import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { verifyAgentRequest, verifyAgentRequestV2 } from './security.js';
import {
  WORKSPACE_RECONNECT_GRACE_SECONDS,
  WORKSPACE_RECONNECT_PROTOCOL_VERSION,
  beginWorkspaceReconnectGrace,
  listWorkspaceReconnectDirectives,
  markWorkspaceReconnectSuspendFailed,
  reconcileWorkspaceReconnectGrace,
  resumeWorkspaceReconnectGrace,
  touchWorkspaceReconnectLiveness,
} from './workspace-reconnect-grace.js';

async function machineForReconnect(db: PrismaClient, machineId: string) {
  return db.machine.findUnique({
    where: { id: machineId },
    select: { agentPublicKey: true, keyRevokedAt: true },
  });
}

async function authenticateAgentGet(
  db: PrismaClient,
  redis: Redis,
  machineId: string,
  request: FastifyRequest,
  routePath: string,
): Promise<boolean> {
  const machine = await machineForReconnect(db, machineId);
  if (!machine || machine.keyRevokedAt) return false;
  return verifyAgentRequest(
    redis,
    machineId,
    machine.agentPublicKey,
    request.method,
    routePath,
    request.headers['x-agent-timestamp'],
    request.headers['x-agent-signature'],
  );
}

async function authenticateAgentBody(
  db: PrismaClient,
  redis: Redis,
  machineId: string,
  request: FastifyRequest,
  routePath: string,
): Promise<boolean> {
  const machine = await machineForReconnect(db, machineId);
  if (!machine || machine.keyRevokedAt) return false;
  const versionHeader = request.headers['x-agent-signature-version'];
  const signatureVersion = Array.isArray(versionHeader) ? versionHeader[0] : versionHeader;
  if (signatureVersion !== '2') return false;
  return verifyAgentRequestV2(
    redis,
    machineId,
    machine.agentPublicKey,
    request.method,
    routePath,
    request.rawBody ?? Buffer.alloc(0),
    {
      timestamp: request.headers['x-agent-timestamp'],
      nonce: request.headers['x-agent-nonce'],
      bodySha256: request.headers['x-agent-body-sha256'],
      signature: request.headers['x-agent-signature-v2'],
      version: request.headers['x-agent-signature-version'],
    },
  );
}

const reconnectEventSchema = z.object({
  machineId: z.string().cuid(),
  event: z.enum(['INTERRUPTED', 'RESUMED', 'LIVENESS', 'SUSPEND_FAILED']),
});

export function registerWorkspaceReconnectRoutes(
  app: FastifyInstance,
  db: PrismaClient,
  redis: Redis,
): void {
  app.get('/agent/workspace-reconnect/:machineId/desired', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const routePath = `/agent/workspace-reconnect/${machineId}/desired`;
    if (!await authenticateAgentGet(db, redis, machineId, request, routePath)) {
      return reply.code(401).send({ error: 'invalid_agent_request' });
    }

    const reconciliation = await reconcileWorkspaceReconnectGrace(db, machineId, new Date());
    const sessions = await listWorkspaceReconnectDirectives(db, machineId);
    return {
      protocolVersion: WORKSPACE_RECONNECT_PROTOCOL_VERSION,
      graceSeconds: WORKSPACE_RECONNECT_GRACE_SECONDS,
      sessions,
      reconciliation,
    };
  });

  app.post('/agent/workspace-reconnect/:sessionId/event', {
    config: { rateLimit: { max: 180, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().cuid() }).parse(request.params);
    const body = reconnectEventSchema.parse(request.body);
    const routePath = `/agent/workspace-reconnect/${sessionId}/event`;
    if (!await authenticateAgentBody(db, redis, body.machineId, request, routePath)) {
      return reply.code(401).send({ error: 'invalid_agent_request' });
    }

    if (body.event === 'LIVENESS') {
      const live = await touchWorkspaceReconnectLiveness(db, sessionId, body.machineId, new Date());
      return { ok: live, event: body.event };
    }

    if (body.event === 'INTERRUPTED') {
      const result = await beginWorkspaceReconnectGrace(db, sessionId, body.machineId, new Date());
      return { ok: true, event: body.event, ...result };
    }

    if (body.event === 'SUSPEND_FAILED') {
      const stopRequested = await markWorkspaceReconnectSuspendFailed(db, sessionId, body.machineId, new Date());
      return { ok: true, event: body.event, stopRequested };
    }

    const result = await resumeWorkspaceReconnectGrace(db, sessionId, body.machineId, new Date());
    return { ok: true, event: body.event, ...result };
  });
}
