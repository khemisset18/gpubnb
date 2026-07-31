import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';

import { requireSession } from './auth.js';
import { config } from './config.js';
import {
  authorizeMiningConfigurationUpdate,
  miningConfigurationInputSchema,
  platformFeeBasisPoints,
} from './mining-config-policy.js';

const machineParamsSchema = z.object({ machineId: z.string().cuid() });
const resourceParamsSchema = machineParamsSchema.extend({ resourceId: z.string().min(3).max(128) });

const runtimeEventSchema = z.object({
  machineId: z.string().cuid(),
  resourceId: z.string().min(3).max(128),
  eventType: z.enum([
    'CONFIGURATION_CHANGED', 'START_REQUESTED', 'STARTED', 'STOP_REQUESTED',
    'STOP_VERIFIED', 'STOP_FAILED', 'RENTAL_PREEMPTED', 'RENTAL_RELEASED',
    'CLEANUP_VERIFIED', 'AUTO_RESUME_REQUESTED', 'QUARANTINED',
    'EMERGENCY_STOPPED', 'HEARTBEAT',
  ]),
  stateBefore: z.string().max(40).nullable().optional(),
  stateAfter: z.enum([
    'IDLE', 'STARTING', 'MINING', 'PREEMPTING', 'VERIFYING_STOP',
    'RENTAL_BLOCKED', 'STOPPED', 'QUARANTINED', 'EMERGENCY_STOPPED',
  ]),
  reservationId: z.string().max(96).nullable().optional(),
  idempotencyKey: z.string().min(16).max(160),
  agentCounter: z.coerce.bigint().nonnegative().nullable().optional(),
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

type MiningResourceRow = {
  id: string;
  machineId: string;
  ownerId: string;
  kind: 'CPU' | 'GPU';
  resourceKey: string;
  displayName: string;
  quarantined: boolean;
  runtimeState: string;
  activeRentalId: string | null;
  configurationId: string | null;
  mode: 'DISABLED' | 'GPUBNB_MANAGED' | 'OWNER_POOL' | null;
  profileId: string | null;
  walletAddress: string | null;
  workerName: string | null;
  ownerPoolEndpoint: string | null;
  autoResumeAfterRental: boolean | null;
  maximumTemperatureC: number | null;
  maximumPowerWatts: number | null;
  maximumCpuPercent: number | null;
  cpuThreadCount: number | null;
  gpuIntensityPercent: number | null;
  platformFeeBasisPoints: number | null;
  version: number | null;
};

const listOwnerResources = async (db: PrismaClient, machineId: string, ownerId: string) =>
  db.$queryRaw<MiningResourceRow[]>(Prisma.sql`
    SELECT r."id", r."machineId", m."ownerId", r."kind", r."resourceKey",
           r."displayName", r."quarantined", r."runtimeState", r."activeRentalId",
           c."id" AS "configurationId", c."mode", c."profileId", c."walletAddress",
           c."workerName", c."ownerPoolEndpoint", c."autoResumeAfterRental",
           c."maximumTemperatureC", c."maximumPowerWatts", c."maximumCpuPercent",
           c."cpuThreadCount", c."gpuIntensityPercent", c."platformFeeBasisPoints", c."version"
      FROM "MiningResource" r
      JOIN "Machine" m ON m."id" = r."machineId"
 LEFT JOIN "MiningConfiguration" c ON c."resourceId" = r."id"
     WHERE r."machineId" = ${machineId} AND m."ownerId" = ${ownerId}
  ORDER BY r."kind", r."resourceKey"
  `);

export const registerMiningRoutes = (
  app: FastifyInstance,
  db: PrismaClient,
  redis: Redis,
): void => {
  app.get('/machines/:machineId/mining-resources', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const { machineId } = machineParamsSchema.parse(request.params);
    const resources = await listOwnerResources(db, machineId, session.userId);
    if (!resources.length) {
      const machine = await db.machine.findFirst({ where: { id: machineId, ownerId: session.userId }, select: { id: true } });
      if (!machine) return reply.code(404).send({ error: 'machine_not_found' });
    }
    return { resources };
  });

  app.put('/machines/:machineId/mining-resources/:resourceId/configuration', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const { machineId, resourceId } = resourceParamsSchema.parse(request.params);
    const input = miningConfigurationInputSchema.parse(request.body);
    if (input.resourceId !== resourceId) return reply.code(400).send({ error: 'resource_id_mismatch' });

    try {
      const configuration = await db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<MiningResourceRow[]>(Prisma.sql`
          SELECT r."id", r."machineId", m."ownerId", r."kind", r."resourceKey",
                 r."displayName", r."quarantined", r."runtimeState", r."activeRentalId",
                 c."id" AS "configurationId", c."mode", c."profileId", c."walletAddress",
                 c."workerName", c."ownerPoolEndpoint", c."autoResumeAfterRental",
                 c."maximumTemperatureC", c."maximumPowerWatts", c."maximumCpuPercent",
                 c."cpuThreadCount", c."gpuIntensityPercent", c."platformFeeBasisPoints", c."version"
            FROM "MiningResource" r
            JOIN "Machine" m ON m."id" = r."machineId"
       LEFT JOIN "MiningConfiguration" c ON c."resourceId" = r."id"
           WHERE r."id" = ${resourceId} AND r."machineId" = ${machineId}
           FOR UPDATE OF r
        `);
        const current = rows[0];
        if (!current) throw new Error('mining_resource_not_found');

        const rentedResourceIds = current.activeRentalId
          ? new Set<string>([current.id])
          : new Set<string>();

        authorizeMiningConfigurationUpdate(input, {
          ownerId: session.userId,
          machineOwnerId: current.ownerId,
          resourceMachineId: current.machineId,
          requestedMachineId: machineId,
          resourceKind: current.kind,
          resourceId: current.id,
          rentedResourceIds,
          machineExclusiveRental: false,
          resourceQuarantined: current.quarantined,
          currentVersion: current.version ?? 0,
          profileApproved: true,
        });

        const feeBps = platformFeeBasisPoints(input.mode);
        const configurationId = current.configurationId ?? crypto.randomUUID();
        const updated = await tx.$queryRaw<MiningResourceRow[]>(Prisma.sql`
          INSERT INTO "MiningConfiguration" (
            "id", "resourceId", "mode", "profileId", "walletAddress", "workerName",
            "ownerPoolEndpoint", "ownerPoolSecretRef", "autoResumeAfterRental",
            "maximumTemperatureC", "maximumPowerWatts", "maximumCpuPercent",
            "cpuThreadCount", "gpuIntensityPercent", "platformFeeBasisPoints",
            "version", "createdAt", "updatedAt"
          ) VALUES (
            ${configurationId}, ${resourceId}, ${input.mode}::"MiningMode", ${input.profileId},
            ${input.walletAddress ?? null}, ${input.workerName}, ${input.ownerPoolEndpoint ?? null},
            ${input.ownerPoolSecretRef ?? null}, ${input.autoResumeAfterRental},
            ${input.maximumTemperatureC}, ${input.maximumPowerWatts},
            ${input.cpuUtilizationLimitPercent ?? null}, ${input.cpuThreadLimit ?? null},
            ${input.gpuIntensityPercent ?? null}, ${feeBps}, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT ("resourceId") DO UPDATE SET
            "mode" = EXCLUDED."mode",
            "profileId" = EXCLUDED."profileId",
            "walletAddress" = EXCLUDED."walletAddress",
            "workerName" = EXCLUDED."workerName",
            "ownerPoolEndpoint" = EXCLUDED."ownerPoolEndpoint",
            "ownerPoolSecretRef" = EXCLUDED."ownerPoolSecretRef",
            "autoResumeAfterRental" = EXCLUDED."autoResumeAfterRental",
            "maximumTemperatureC" = EXCLUDED."maximumTemperatureC",
            "maximumPowerWatts" = EXCLUDED."maximumPowerWatts",
            "maximumCpuPercent" = EXCLUDED."maximumCpuPercent",
            "cpuThreadCount" = EXCLUDED."cpuThreadCount",
            "gpuIntensityPercent" = EXCLUDED."gpuIntensityPercent",
            "platformFeeBasisPoints" = EXCLUDED."platformFeeBasisPoints",
            "version" = "MiningConfiguration"."version" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "MiningConfiguration"."version" = ${input.expectedVersion}
          RETURNING "id" AS "configurationId", "resourceId" AS "id", ${machineId}::text AS "machineId",
                    ${session.userId}::text AS "ownerId", ${input.resourceKind}::"MiningResourceKind" AS "kind",
                    ''::text AS "resourceKey", ''::text AS "displayName", false AS "quarantined",
                    'IDLE'::text AS "runtimeState", NULL::text AS "activeRentalId", "mode", "profileId",
                    "walletAddress", "workerName", "ownerPoolEndpoint", "autoResumeAfterRental",
                    "maximumTemperatureC", "maximumPowerWatts", "maximumCpuPercent", "cpuThreadCount",
                    "gpuIntensityPercent", "platformFeeBasisPoints", "version"
        `);
        if (!updated.length) throw new Error('mining_configuration_version_conflict');

        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "MiningAuditLog" (
            "id", "machineId", "resourceId", "configurationId", "actorType", "actorId",
            "action", "requestId", "previousValue", "nextValue", "createdAt"
          ) VALUES (
            ${crypto.randomUUID()}, ${machineId}, ${resourceId}, ${configurationId},
            'OWNER'::"MiningAuditActorType", ${session.userId}, 'mining_configuration_updated',
            ${request.id}, ${JSON.stringify(current)}::jsonb, ${JSON.stringify(input)}::jsonb, CURRENT_TIMESTAMP
          )
        `);
        return updated[0];
      });
      return { configuration };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'mining_configuration_update_failed';
      const status = code.endsWith('_not_found') ? 404 : code.includes('owner_required') ? 403 : 409;
      return reply.code(status).send({ error: code });
    }
  });

  app.post('/internal/mining/runtime-events', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${config.INTERNAL_SERVICE_TOKEN}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const event = runtimeEventSchema.parse(request.body);
    const inserted = await db.$transaction(async (tx) => {
      const resource = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "MiningResource"
         WHERE "id" = ${event.resourceId} AND "machineId" = ${event.machineId}
         FOR UPDATE
      `);
      if (!resource.length) throw new Error('mining_resource_not_found');
      const count = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "MiningRuntimeEvent" (
          "id", "resourceId", "eventType", "stateBefore", "stateAfter", "reservationId",
          "idempotencyKey", "agentCounter", "payload", "occurredAt", "createdAt"
        ) VALUES (
          ${crypto.randomUUID()}, ${event.resourceId}, ${event.eventType}::"MiningEventType",
          ${event.stateBefore ?? null}::"MiningRuntimeState", ${event.stateAfter}::"MiningRuntimeState",
          ${event.reservationId ?? null}, ${event.idempotencyKey}, ${event.agentCounter ?? null},
          ${JSON.stringify(event.payload ?? {})}::jsonb, ${new Date(event.occurredAt)}, CURRENT_TIMESTAMP
        ) ON CONFLICT ("idempotencyKey") DO NOTHING
      `);
      if (count > 0) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "MiningResource" SET "runtimeState" = ${event.stateAfter}::"MiningRuntimeState",
                 "activeRentalId" = ${event.reservationId ?? null}, "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = ${event.resourceId}
        `);
      }
      return count > 0;
    });
    return { accepted: inserted };
  });
};
