import type { FastifyInstance, FastifyReply } from 'fastify';
import { ModerationStatus, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { requireSession } from './auth.js';
import {
  DeviceAuthorizationError,
  createDeviceAuthorization,
} from './device-authorization.js';
import { RedisDeviceAuthorizationStore } from './device-authorization-store.js';
import { registerMiningRoutes } from './mining-routes.js';
import { syncMiningResourcesFromInventory } from './mining-resource-inventory.js';
import { registerWorkspaceRenterRoutes } from './workspace-renter-routes.js';
import { registerArtifactTransportGuards } from './artifact-transport-guards.js';
import { registerWorkspaceBrowserSecurity } from './workspace-browser-security.js';
import { registerRentalMarketplaceRoutes } from './rental-marketplace-routes.js';
import { registerMachineDiagnosticsRoutes } from './machine-diagnostics-routes.js';
import { syncMachineAuthCache } from './machine-auth-cache.js';
import { config } from './config.js';
import { controlChannelAssignment } from './agent-control-channel.js';
import { configureSchedulerPresence } from './scheduler-presence.js';
import { recordSecurityFailure, verifyAgentRequest } from './security.js';

const agentPublicKeySchema = z.string().min(32).max(64).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const machineFingerprintSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const userCodeSchema = z.string().trim().toUpperCase().regex(/^[A-F0-9]{10}$/);

export const inventorySchema = z.object({
  agentVersion: z.string().trim().min(1).max(40),
  system: z.object({
    os: z.string().max(80),
    osVersion: z.string().max(300),
    cpu: z.string().max(300),
    cpuCount: z.number().int().min(1).max(1024).nullable().optional(),
    ramTotalMiB: z.number().int().min(1).max(100_000_000).nullable().optional(),
    diskTotalMiB: z.number().int().min(1).max(1_000_000_000),
    dockerAvailable: z.boolean(),
    nvidiaRuntimeAvailable: z.boolean().optional(),
    virtualizationAvailable: z.boolean().optional(),
    desktopGpuRenderingAvailable: z.boolean().optional(),
  }),
  gpus: z.array(z.object({
    gpuModel: z.string().max(160),
    gpuUuid: z.string().max(200),
    vramMiB: z.number().int().positive().max(1_000_000),
    driverVersion: z.string().max(80),
    cudaVersion: z.string().max(40).nullable().optional(),
    gpuVendor: z.string().max(20).nullable().optional(),
  })).max(16),
});

const sendAuthorizationError = (reply: FastifyReply, error: DeviceAuthorizationError) => {
  switch (error.code) {
    case 'authorization_pending':
      return reply.code(428).send({ error: error.code });
    case 'authorization_not_found':
    case 'authorization_expired':
      return reply.code(404).send({ error: error.code });
    case 'authorization_already_authorized':
    case 'authorization_already_consumed':
    case 'device_identity_mismatch':
      return reply.code(409).send({ error: error.code });
    default:
      return reply.code(400).send({ error: error.code });
  }
};

export const registerDeviceAuthorizationRoutes = (
  app: FastifyInstance,
  db: PrismaClient,
  redis: Redis,
): void => {
  const store = new RedisDeviceAuthorizationStore(redis);
  configureSchedulerPresence(redis, config.MACHINE_PRESENCE_MODE);
  registerArtifactTransportGuards(app);
  registerWorkspaceBrowserSecurity(app);
  registerMiningRoutes(app, db, redis);
  registerWorkspaceRenterRoutes(app, db, redis);
  registerRentalMarketplaceRoutes(app, db, redis);
  registerMachineDiagnosticsRoutes(app, db, redis);

  app.get('/agent/control-channel/:machineId', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const machine = await db.machine.findUnique({
      where: { id: machineId },
      select: {
        id: true,
        agentPublicKey: true,
        moderationStatus: true,
        keyRevokedAt: true,
      },
    });
    if (!machine) return reply.code(404).send({ error: 'unknown_machine' });
    if (machine.keyRevokedAt) return reply.code(403).send({ error: 'agent_key_revoked' });
    if (machine.moderationStatus !== ModerationStatus.CLEAR) {
      return reply.code(403).send({ error: 'machine_quarantined' });
    }
    const routePath = `/agent/control-channel/${machineId}`;
    const valid = await verifyAgentRequest(
      redis,
      machineId,
      machine.agentPublicKey,
      'GET',
      routePath,
      request.headers['x-agent-timestamp'],
      request.headers['x-agent-signature'],
    );
    if (!valid) {
      await recordSecurityFailure(redis, `agent-control:${machineId}`);
      return reply.code(401).send({ error: 'invalid_agent_request' });
    }
    return controlChannelAssignment(machineId, config);
  });

  app.post('/agent/device-authorizations', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = z.object({
      publicKey: agentPublicKeySchema,
      machineFingerprint: machineFingerprintSchema,
    }).parse(request.body);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const challenge = createDeviceAuthorization(body);
      try {
        await store.create(challenge.record);
        return reply.code(201).send({
          deviceCode: challenge.deviceCode,
          userCode: challenge.userCode,
          verificationPath: challenge.verificationPath,
          expiresIn: challenge.expiresIn,
          interval: challenge.interval,
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'device_authorization_collision') throw error;
      }
    }

    return reply.code(503).send({ error: 'device_authorization_unavailable' });
  });

  app.post('/host/device-authorizations/authorize', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;

    const user = await db.user.findUnique({ where: { id: session.userId }, select: { canHost: true } });
    if (!user?.canHost) return reply.code(403).send({ error: 'provider_role_required' });

    const { userCode } = z.object({ userCode: userCodeSchema }).parse(request.body);
    try {
      const record = await store.authorize(userCode, session.userId);
      return { ok: true, expiresAt: new Date(record.expiresAtUnix * 1000).toISOString() };
    } catch (error) {
      if (error instanceof DeviceAuthorizationError) return sendAuthorizationError(reply, error);
      throw error;
    }
  });

  app.post('/agent/device-authorizations/exchange', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = z.object({
      deviceCode: z.string().min(40).max(100),
      publicKey: agentPublicKeySchema,
      machineFingerprint: machineFingerprintSchema,
      inventory: inventorySchema,
    }).parse(request.body);

    try {
      const authorization = await store.consume(body.deviceCode, body.publicKey, body.machineFingerprint);
      const miningInventory = {
        system: {
          cpu: body.inventory.system.cpu,
          cpuCount: body.inventory.system.cpuCount ?? null,
        },
        gpus: body.inventory.gpus.map((gpu) => ({
          gpuUuid: gpu.gpuUuid,
          gpuModel: gpu.gpuModel,
          vramMiB: gpu.vramMiB,
          driverVersion: gpu.driverVersion,
          cudaVersion: gpu.cudaVersion ?? null,
          gpuVendor: gpu.gpuVendor ?? null,
        })),
      };

      const existing = await db.machine.findUnique({
        where: { agentPublicKey: authorization.publicKey },
        select: { id: true, ownerId: true, keyCreatedAt: true },
      });
      if (existing) {
        if (existing.ownerId !== authorization.ownerId) return reply.code(409).send({ error: 'agent_key_already_registered' });
        await syncMiningResourcesFromInventory(db, existing.id, miningInventory);
        await syncMachineAuthCache(redis, {
          machineId: existing.id,
          agentPublicKey: authorization.publicKey,
          keyVersion: 1,
        });
        return { machineId: existing.id, linkedAt: existing.keyCreatedAt.toISOString() };
      }

      const gpu = body.inventory.gpus[0];
      const machine = await db.machine.create({
        data: {
          ownerId: authorization.ownerId,
          agentPublicKey: authorization.publicKey,
          agentVersion: body.inventory.agentVersion,
          operatingSystem: body.inventory.system.os,
          osVersion: body.inventory.system.osVersion,
          cpuModel: body.inventory.system.cpu,
          cpuCount: body.inventory.system.cpuCount ?? null,
          ramTotalMiB: body.inventory.system.ramTotalMiB ?? null,
          diskTotalMiB: body.inventory.system.diskTotalMiB,
          dockerAvailable: body.inventory.system.dockerAvailable,
          nvidiaRuntimeAvailable: body.inventory.system.nvidiaRuntimeAvailable ?? false,
          virtualizationAvailable: body.inventory.system.virtualizationAvailable ?? false,
          desktopGpuRenderingAvailable: body.inventory.system.desktopGpuRenderingAvailable ?? false,
          ...(gpu ? {
            gpuModel: gpu.gpuModel,
            gpuUuid: gpu.gpuUuid,
            vramMiB: gpu.vramMiB,
            driverVersion: gpu.driverVersion,
            cudaVersion: gpu.cudaVersion ?? null,
            gpuVendor: gpu.gpuVendor ?? null,
          } : {}),
        },
        select: { id: true, keyCreatedAt: true },
      });

      await syncMiningResourcesFromInventory(db, machine.id, miningInventory);
      await syncMachineAuthCache(redis, {
        machineId: machine.id,
        agentPublicKey: authorization.publicKey,
        keyVersion: 1,
      });
      return reply.code(201).send({ machineId: machine.id, linkedAt: machine.keyCreatedAt.toISOString() });
    } catch (error) {
      if (error instanceof DeviceAuthorizationError) return sendAuthorizationError(reply, error);
      throw error;
    }
  });
};
