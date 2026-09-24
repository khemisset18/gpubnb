import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';

import { requireSession } from './auth.js';
import { runBookingTransaction } from './booking-transaction-retry.js';
import {
  authorizeMiningConfigurationUpdate,
  miningConfigurationInputSchema,
  platformFeeBasisPoints,
} from './mining-config-policy.js';
import { normalizeMiningGpuVendor } from './mining-profile-catalog.js';
import { registerRentalResourceAuthorityRoutes } from './rental-resource-routes.js';
import { recordSecurityFailure, verifyAgentRequestV2 } from './security.js';

const machineParamsSchema = z.object({ machineId: z.string().cuid() });
const resourceParamsSchema = machineParamsSchema.extend({ resourceId: z.string().min(3).max(128) });

const runtimeStates = [
  'IDLE', 'STARTING', 'MINING', 'PREEMPTING', 'VERIFYING_STOP',
  'RENTAL_BLOCKED', 'STOPPED', 'QUARANTINED', 'EMERGENCY_STOPPED',
] as const;

const MINING_TELEMETRY_LIVE_TTL_SECONDS = 90;
const MINING_TELEMETRY_DEDUPE_TTL_SECONDS = 300;
const MINING_TELEMETRY_HISTORY_INTERVAL_MS = 5 * 60 * 1000;
const MINING_TELEMETRY_HISTORY_HOURS = 24;

const miningTelemetrySchema = z.object({
  resourceId: z.string().min(3).max(128),
  hardwareUuid: z.string().min(8).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
  runtimeGeneration: z.string().regex(/^[1-9][0-9]{0,18}$/),
  profileId: z.string().min(3).max(96).regex(/^[A-Za-z0-9_.:-]+$/).nullable(),
  processPid: z.number().int().positive().max(2_147_483_647).nullable(),
  temperatureC: z.number().finite().min(0).max(150),
  powerWatts: z.number().finite().min(0).max(5000).nullable(),
  gpuUtilizationPercent: z.number().finite().min(0).max(100).nullable(),
  memoryUsedMiB: z.number().finite().min(0).max(1_000_000).nullable(),
  deviceName: z.string().max(200).nullable(),
  thermalStopCelsius: z.number().int().min(85).max(98),
  hashrate: z.number().finite().min(0).max(1e18).nullable(),
  hashrateUnit: z.string().min(1).max(16).regex(/^[A-Za-z0-9/._-]+$/).nullable(),
  acceptedShares: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  staleShares: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  hardwareErrors: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  uptimeSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  poolConnected: z.boolean(),
}).strict();

const miningTelemetryEnvelopeSchema = z.object({
  machineId: z.string().cuid(),
  resourceId: z.string().min(3).max(128),
  idempotencyKey: z.string().min(16).max(160),
  agentCounter: z.coerce.bigint().positive(),
  capturedAt: z.string().datetime(),
  telemetry: miningTelemetrySchema,
}).strict().superRefine((value, context) => {
  if (value.telemetry.resourceId !== value.resourceId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['telemetry', 'resourceId'],
      message: 'mining_telemetry_resource_mismatch',
    });
  }
});

const miningTelemetryLatestKey = (resourceId: string): string =>
  `mining:telemetry:latest:${resourceId}`;

const runtimeEventSchema = z.object({
  machineId: z.string().cuid(),
  resourceId: z.string().min(3).max(128),
  eventType: z.enum([
    'CONFIGURATION_CHANGED', 'START_REQUESTED', 'STARTED', 'STOP_REQUESTED',
    'STOP_VERIFIED', 'STOP_FAILED', 'RENTAL_PREEMPTED', 'RENTAL_RELEASED',
    'CLEANUP_VERIFIED', 'AUTO_RESUME_REQUESTED', 'QUARANTINED',
    'EMERGENCY_STOPPED', 'HEARTBEAT',
  ]),
  stateBefore: z.enum(runtimeStates).nullable().optional(),
  stateAfter: z.enum(runtimeStates),
  reservationId: z.string().max(96).nullable().optional(),
  idempotencyKey: z.string().min(16).max(160),
  agentCounter: z.coerce.bigint().positive(),
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
  gpuVendor: string | null;
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

type ExistingRuntimeEventRow = {
  resourceId: string;
  eventType: string;
  stateAfter: string;
  reservationId: string | null;
  agentCounter: bigint;
};

const listOwnerResources = async (db: PrismaClient, machineId: string, ownerId: string) =>
  db.$queryRaw<MiningResourceRow[]>(Prisma.sql`
    SELECT r."id", r."machineId", m."ownerId", r."kind", r."resourceKey",
           r."displayName", a."vendor" AS "gpuVendor", r."quarantined",
           r."runtimeState", r."activeRentalId", c."id" AS "configurationId",
           c."mode", c."profileId", c."walletAddress", c."workerName",
           c."ownerPoolEndpoint", c."autoResumeAfterRental", c."maximumTemperatureC",
           c."maximumPowerWatts", c."maximumCpuPercent", c."cpuThreadCount",
           c."gpuIntensityPercent", c."platformFeeBasisPoints", c."version"
      FROM "MiningResource" r
      JOIN "Machine" m ON m."id" = r."machineId"
 LEFT JOIN "Accelerator" a ON a."id" = r."acceleratorId"
 LEFT JOIN "MiningConfiguration" c ON c."resourceId" = r."id"
     WHERE r."machineId" = ${machineId} AND m."ownerId" = ${ownerId}
  ORDER BY r."kind", r."resourceKey"
  `);

export const registerMiningRoutes = (
  app: FastifyInstance,
  db: PrismaClient,
  redis: Redis,
): void => {
  registerRentalResourceAuthorityRoutes(app, db, redis);

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

  app.get('/machines/:machineId/mining-resources/:resourceId/telemetry', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const { machineId, resourceId } = resourceParamsSchema.parse(request.params);
    const resource = await db.miningResource.findFirst({
      where: { id: resourceId, machineId, machine: { ownerId: session.userId } },
      select: { id: true },
    });
    if (!resource) return reply.code(404).send({ error: 'mining_resource_not_found' });

    const [latestRaw, history] = await Promise.all([
      redis.get(miningTelemetryLatestKey(resourceId)),
      db.miningTelemetrySample.findMany({
        where: {
          resourceId,
          capturedAt: { gte: new Date(Date.now() - MINING_TELEMETRY_HISTORY_HOURS * 60 * 60 * 1000) },
        },
        orderBy: { capturedAt: 'desc' },
        take: 288,
      }),
    ]);
    let latest: unknown = null;
    if (latestRaw) {
      try {
        latest = JSON.parse(latestRaw);
      } catch {
        latest = null;
      }
    }
    return {
      latest,
      history: history.map((sample) => ({
        ...sample,
        agentCounter: sample.agentCounter.toString(),
        runtimeGeneration: sample.runtimeGeneration.toString(),
        acceptedShares: sample.acceptedShares?.toString() ?? null,
        staleShares: sample.staleShares?.toString() ?? null,
        hardwareErrors: sample.hardwareErrors?.toString() ?? null,
        uptimeSeconds: sample.uptimeSeconds?.toString() ?? null,
      })),
    };
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
                 r."displayName", a."vendor" AS "gpuVendor", r."quarantined",
                 r."runtimeState", r."activeRentalId", c."id" AS "configurationId",
                 c."mode", c."profileId", c."walletAddress", c."workerName",
                 c."ownerPoolEndpoint", c."autoResumeAfterRental", c."maximumTemperatureC",
                 c."maximumPowerWatts", c."maximumCpuPercent", c."cpuThreadCount",
                 c."gpuIntensityPercent", c."platformFeeBasisPoints", c."version"
            FROM "MiningResource" r
            JOIN "Machine" m ON m."id" = r."machineId"
       LEFT JOIN "Accelerator" a ON a."id" = r."acceleratorId"
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
          gpuVendor: normalizeMiningGpuVendor(current.gpuVendor),
          rentedResourceIds,
          machineExclusiveRental: false,
          resourceQuarantined: current.quarantined,
          currentVersion: current.version ?? 0,
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
                    ''::text AS "resourceKey", ''::text AS "displayName", NULL::text AS "gpuVendor",
                    false AS "quarantined", 'IDLE'::text AS "runtimeState", NULL::text AS "activeRentalId",
                    "mode", "profileId", "walletAddress", "workerName", "ownerPoolEndpoint",
                    "autoResumeAfterRental", "maximumTemperatureC", "maximumPowerWatts",
                    "maximumCpuPercent", "cpuThreadCount", "gpuIntensityPercent",
                    "platformFeeBasisPoints", "version"
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

  app.post('/internal/mining/telemetry', async (request, reply) => {
    const envelope = miningTelemetryEnvelopeSchema.parse(request.body);
    const rawBody = request.rawBody;
    if (!rawBody) {
      await recordSecurityFailure(redis, `agent-v2:${envelope.machineId}`, 4);
      return reply.code(400).send({ error: 'raw_body_required' });
    }

    const machine = await db.machine.findUnique({
      where: { id: envelope.machineId },
      select: { agentPublicKey: true, keyRevokedAt: true, moderationStatus: true },
    });
    if (!machine) return reply.code(404).send({ error: 'unknown_machine' });
    if (machine.keyRevokedAt || machine.moderationStatus === 'QUARANTINED') {
      return reply.code(403).send({ error: 'machine_not_authorized' });
    }

    const validSignature = await verifyAgentRequestV2(
      redis,
      envelope.machineId,
      machine.agentPublicKey,
      request.method,
      '/internal/mining/telemetry',
      rawBody,
      {
        timestamp: request.headers['x-agent-timestamp'],
        nonce: request.headers['x-agent-nonce'],
        bodySha256: request.headers['x-agent-body-sha256'],
        signature: request.headers['x-agent-signature-v2'],
        version: request.headers['x-agent-signature-version'],
      },
    );
    if (!validSignature) {
      await recordSecurityFailure(redis, `agent-v2:${envelope.machineId}`, 4);
      return reply.code(401).send({ error: 'invalid_agent_request' });
    }

    const dedupeKey = `mining:telemetry:dedupe:${envelope.machineId}:${envelope.idempotencyKey}`;
    if (await redis.set(dedupeKey, '1', 'EX', MINING_TELEMETRY_DEDUPE_TTL_SECONDS, 'NX') !== 'OK') {
      return { accepted: false, duplicate: true };
    }

    const capturedAt = new Date(envelope.capturedAt);
    try {
      const persisted = await runBookingTransaction(db, async (tx) => {
        const rows = await tx.$queryRaw<Array<{
          id: string;
          runtimeState: string;
          kind: string;
          hardwareUuid: string | null;
        }>>(Prisma.sql`
          SELECT r."id", r."runtimeState"::text AS "runtimeState", r."kind"::text AS "kind",
                 a."hardwareUuid"
            FROM "MiningResource" r
       LEFT JOIN "Accelerator" a ON a."id" = r."acceleratorId"
           WHERE r."id" = ${envelope.resourceId} AND r."machineId" = ${envelope.machineId}
           FOR UPDATE OF r
        `);
        const resource = rows[0];
        if (!resource) throw new Error('mining_resource_not_found');
        if (resource.kind !== 'GPU' || !resource.hardwareUuid) {
          throw new Error('mining_telemetry_gpu_resource_required');
        }
        if (resource.hardwareUuid.toLowerCase() !== envelope.telemetry.hardwareUuid.toLowerCase()) {
          throw new Error('mining_telemetry_hardware_mismatch');
        }
        if (resource.runtimeState !== 'MINING') {
          throw new Error('mining_resource_not_mining');
        }

        const advanced = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "Machine"
             SET "lastCounter" = ${envelope.agentCounter}, "keyLastUsedAt" = CURRENT_TIMESTAMP
           WHERE "id" = ${envelope.machineId} AND "lastCounter" < ${envelope.agentCounter}
           RETURNING "id"
        `);
        if (!advanced.length) throw new Error('agent_counter_replay');

        const previous = await tx.miningTelemetrySample.findFirst({
          where: { resourceId: envelope.resourceId },
          orderBy: { capturedAt: 'desc' },
          select: { capturedAt: true },
        });
        const shouldPersist = !previous
          || capturedAt.getTime() - previous.capturedAt.getTime() >= MINING_TELEMETRY_HISTORY_INTERVAL_MS;
        if (!shouldPersist) return false;

        const telemetry = envelope.telemetry;
        await tx.miningTelemetrySample.create({
          data: {
            id: crypto.randomUUID(),
            resourceId: envelope.resourceId,
            capturedAt,
            agentCounter: envelope.agentCounter,
            runtimeGeneration: BigInt(telemetry.runtimeGeneration),
            hardwareUuid: telemetry.hardwareUuid,
            profileId: telemetry.profileId,
            processPid: telemetry.processPid,
            temperatureC: telemetry.temperatureC,
            powerWatts: telemetry.powerWatts,
            gpuUtilizationPercent: telemetry.gpuUtilizationPercent,
            memoryUsedMiB: telemetry.memoryUsedMiB,
            hashrate: telemetry.hashrate,
            hashrateUnit: telemetry.hashrateUnit,
            acceptedShares: telemetry.acceptedShares === null ? null : BigInt(telemetry.acceptedShares),
            staleShares: telemetry.staleShares === null ? null : BigInt(telemetry.staleShares),
            hardwareErrors: telemetry.hardwareErrors === null ? null : BigInt(telemetry.hardwareErrors),
            uptimeSeconds: telemetry.uptimeSeconds === null ? null : BigInt(telemetry.uptimeSeconds),
            poolConnected: telemetry.poolConnected,
            thermalStopCelsius: telemetry.thermalStopCelsius,
          },
        });
        return true;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      });

      const live = JSON.stringify({
        capturedAt: envelope.capturedAt,
        ...envelope.telemetry,
      });
      try {
        await redis.set(
          miningTelemetryLatestKey(envelope.resourceId),
          live,
          'EX',
          MINING_TELEMETRY_LIVE_TTL_SECONDS,
        );
      } catch (error) {
        request.log.warn({ err: error, resourceId: envelope.resourceId }, 'mining_telemetry_live_cache_failed');
      }
      return { accepted: true, persisted };
    } catch (error) {
      await redis.del(dedupeKey).catch(() => undefined);
      const code = error instanceof Error ? error.message : 'mining_telemetry_rejected';
      const status = code === 'mining_resource_not_found' ? 404
        : code === 'machine_not_authorized' ? 403
          : 409;
      return reply.code(status).send({ error: code });
    }
  });

  app.post('/internal/mining/runtime-events', async (request, reply) => {
    const event = runtimeEventSchema.parse(request.body);
    const rawBody = request.rawBody;
    if (!rawBody) {
      await recordSecurityFailure(redis, `agent-v2:${event.machineId}`, 4);
      return reply.code(400).send({ error: 'raw_body_required' });
    }

    const machine = await db.machine.findUnique({
      where: { id: event.machineId },
      select: { agentPublicKey: true, keyRevokedAt: true, moderationStatus: true },
    });
    if (!machine) return reply.code(404).send({ error: 'unknown_machine' });
    if (machine.keyRevokedAt || machine.moderationStatus === 'QUARANTINED') {
      return reply.code(403).send({ error: 'machine_not_authorized' });
    }

    const validSignature = await verifyAgentRequestV2(
      redis,
      event.machineId,
      machine.agentPublicKey,
      request.method,
      '/internal/mining/runtime-events',
      rawBody,
      {
        timestamp: request.headers['x-agent-timestamp'],
        nonce: request.headers['x-agent-nonce'],
        bodySha256: request.headers['x-agent-body-sha256'],
        signature: request.headers['x-agent-signature-v2'],
        version: request.headers['x-agent-signature-version'],
      },
    );
    if (!validSignature) {
      await recordSecurityFailure(redis, `agent-v2:${event.machineId}`, 4);
      return reply.code(401).send({ error: 'invalid_agent_request' });
    }

    try {
      const inserted = await runBookingTransaction(db, async (tx) => {
        const resource = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "MiningResource"
           WHERE "id" = ${event.resourceId} AND "machineId" = ${event.machineId}
           FOR UPDATE
        `);
        if (!resource.length) throw new Error('mining_resource_not_found');

        const existing = await tx.$queryRaw<ExistingRuntimeEventRow[]>(Prisma.sql`
          SELECT e."resourceId", e."eventType"::text AS "eventType",
                 e."stateAfter"::text AS "stateAfter", e."reservationId", e."agentCounter"
            FROM "MiningRuntimeEvent" e
            JOIN "MiningResource" r ON r."id" = e."resourceId"
           WHERE e."idempotencyKey" = ${event.idempotencyKey}
             AND r."machineId" = ${event.machineId}
        `);
        if (existing.length) {
          const previous = existing[0]!;
          const sameEvent = previous.resourceId === event.resourceId
            && previous.eventType === event.eventType
            && previous.stateAfter === event.stateAfter
            && previous.reservationId === (event.reservationId ?? null)
            && previous.agentCounter === event.agentCounter;
          if (!sameEvent) throw new Error('idempotency_key_collision');
          return false;
        }

        const advanced = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "Machine"
             SET "lastCounter" = ${event.agentCounter}, "keyLastUsedAt" = CURRENT_TIMESTAMP
           WHERE "id" = ${event.machineId} AND "lastCounter" < ${event.agentCounter}
           RETURNING "id"
        `);
        if (!advanced.length) throw new Error('agent_counter_replay');

        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "MiningRuntimeEvent" (
            "id", "resourceId", "eventType", "stateBefore", "stateAfter", "reservationId",
            "idempotencyKey", "agentCounter", "payload", "occurredAt", "createdAt"
          ) VALUES (
            ${crypto.randomUUID()}, ${event.resourceId}, ${event.eventType}::"MiningEventType",
            ${event.stateBefore ?? null}::"MiningRuntimeState", ${event.stateAfter}::"MiningRuntimeState",
            ${event.reservationId ?? null}, ${event.idempotencyKey}, ${event.agentCounter},
            ${JSON.stringify(event.payload ?? {})}::jsonb, ${new Date(event.occurredAt)}, CURRENT_TIMESTAMP
          )
        `);

        await tx.$executeRaw(Prisma.sql`
          UPDATE "MiningResource"
             SET "runtimeState" = ${event.stateAfter}::"MiningRuntimeState",
                 "activeRentalId" = CASE
                   WHEN ${event.eventType}::"MiningEventType" IN (
                     'RENTAL_RELEASED'::"MiningEventType", 'CLEANUP_VERIFIED'::"MiningEventType"
                   ) THEN NULL
                   WHEN ${event.reservationId ?? null} IS NOT NULL
                    AND ${event.eventType}::"MiningEventType" IN (
                      'RENTAL_PREEMPTED'::"MiningEventType", 'STOP_REQUESTED'::"MiningEventType",
                      'STOP_VERIFIED'::"MiningEventType", 'STOP_FAILED'::"MiningEventType"
                    ) THEN ${event.reservationId ?? null}
                   ELSE "activeRentalId"
                 END,
                 "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = ${event.resourceId}
        `);
        return true;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      });
      return { accepted: inserted };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'runtime_event_rejected';
      const status = code === 'mining_resource_not_found' ? 404 : 409;
      return reply.code(status).send({ error: code });
    }
  });
};