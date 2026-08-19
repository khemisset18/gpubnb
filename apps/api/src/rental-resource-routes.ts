import { ModerationStatus, type PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { recordSecurityFailure, verifyAgentRequestV2 } from './security.js';
import {
  buildRentalResourceAuthority,
  releaseRentalResourceAuthority,
} from './rental-resource-authority.js';

const machineParamsSchema = z.object({ machineId: z.string().cuid() });
const sessionParamsSchema = machineParamsSchema.extend({ sessionId: z.string().cuid() });
const releaseBodySchema = z.object({
  leases: z.array(z.object({
    resourceId: z.string().min(8).max(191),
    holderId: z.string().min(8).max(191),
    leaseId: z.string().min(8).max(191),
    fencingToken: z.string().regex(/^[1-9]\d{0,18}$/),
  }).strict()).min(1).max(16),
}).strict();

async function authenticateAgent(
  db: PrismaClient,
  redis: Redis,
  machineId: string,
  request: FastifyRequest,
  routePath: string,
): Promise<boolean> {
  const machine = await db.machine.findUnique({
    where: { id: machineId },
    select: { agentPublicKey: true, keyRevokedAt: true, moderationStatus: true },
  });
  if (!machine || machine.keyRevokedAt || machine.moderationStatus !== ModerationStatus.CLEAR) {
    return false;
  }
  const rawBody = request.rawBody ?? Buffer.alloc(0);
  const valid = await verifyAgentRequestV2(
    redis,
    machineId,
    machine.agentPublicKey,
    request.method,
    routePath,
    rawBody,
    {
      timestamp: request.headers['x-agent-timestamp'],
      nonce: request.headers['x-agent-nonce'],
      bodySha256: request.headers['x-agent-body-sha256'],
      signature: request.headers['x-agent-signature-v2'],
      version: request.headers['x-agent-signature-version'],
    },
  );
  if (!valid) await recordSecurityFailure(redis, `agent-v2:${machineId}`, 4);
  return valid;
}

export function registerRentalResourceAuthorityRoutes(
  app: FastifyInstance,
  db: PrismaClient,
  redis: Redis,
): void {
  app.get('/agent/mining/:machineId/rental-authority', async (request, reply) => {
    const { machineId } = machineParamsSchema.parse(request.params);
    const route = `/agent/mining/${machineId}/rental-authority`;
    if (!await authenticateAgent(db, redis, machineId, request, route)) {
      return reply.code(401).send({ error: 'invalid_agent_request' });
    }
    try {
      const authority = await buildRentalResourceAuthority(db, redis, machineId);
      for (const session of authority.sessions) {
        if (session.blockedReason) {
          // Traces the exact reason a session's GPU resource authority is blocked
          // (e.g. rental_gpu_resource_mapping_missing, rental_gpu_resource_disabled,
          // rental_gpu_resource_quarantined) with the full machineId -> sessionId
          // chain, without needing to reproduce the failure to understand it.
          request.log.warn(
            { machineId, sessionId: session.sessionId, blockedReason: session.blockedReason },
            'rental_resource_authority_session_blocked',
          );
        }
      }
      return authority;
    } catch (error) {
      const code = error instanceof Error ? error.message : 'rental_resource_authority_failed';
      request.log.warn({ machineId, code }, 'rental_resource_authority_failed');
      return reply.code(code.endsWith('_conflict') ? 409 : 503).send({ error: code });
    }
  });

  app.post('/agent/mining/:machineId/rental-authority/:sessionId/release', async (request, reply) => {
    const { machineId, sessionId } = sessionParamsSchema.parse(request.params);
    const route = `/agent/mining/${machineId}/rental-authority/${sessionId}/release`;
    if (!await authenticateAgent(db, redis, machineId, request, route)) {
      return reply.code(401).send({ error: 'invalid_agent_request' });
    }
    const body = releaseBodySchema.parse(request.body);
    try {
      return await releaseRentalResourceAuthority(db, redis, machineId, sessionId, body.leases);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'rental_resource_release_failed';
      const status = code.endsWith('_not_found') ? 404 : code.includes('not_releasable') ? 409 : 409;
      return reply.code(status).send({ error: code });
    }
  });
}
