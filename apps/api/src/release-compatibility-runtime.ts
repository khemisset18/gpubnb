import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ListingStatus, MachineOperational, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { requireSession } from './auth.js';
import { releaseCompatibilityDescriptor } from './release-compatibility.js';
import {
  evaluateReportedCompatibility,
  releaseCompatibilityMode,
  type ReleaseCompatibilityObservation,
} from './release-compatibility-policy.js';

const heartbeatObservationSchema = z.object({
  machineId: z.string().cuid(),
  telemetry: z.object({
    schemaVersion: z.literal(2),
    releaseCompatibility: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough();

const keyFor = (machineId: string) => `machine:${machineId}:release-compatibility:v1`;

export async function storeReleaseCompatibilityObservation(
  redis: Redis,
  machineId: string,
  observation: ReleaseCompatibilityObservation,
): Promise<void> {
  // Heartbeats are nominally every 10s. Five minutes keeps diagnostics useful
  // through a brief outage while still making stale protocol evidence expire.
  await redis.set(keyFor(machineId), JSON.stringify(observation), 'EX', 300);
}

export async function readReleaseCompatibilityObservation(
  redis: Redis,
  machineId: string,
): Promise<ReleaseCompatibilityObservation | null> {
  const raw = await redis.get(keyFor(machineId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ReleaseCompatibilityObservation;
    if (value?.schemaVersion !== 1 || typeof value.compatible !== 'boolean') return null;
    return value;
  } catch {
    return null;
  }
}

async function observeSuccessfulHeartbeat(
  app: FastifyInstance,
  db: PrismaClient,
  redis: Redis,
  request: FastifyRequest,
  payload: unknown,
): Promise<unknown> {
  const body = heartbeatObservationSchema.safeParse(request.body);
  if (!body.success) return payload;

  const observation = evaluateReportedCompatibility(
    body.data.telemetry?.releaseCompatibility,
  );
  try {
    await storeReleaseCompatibilityObservation(redis, body.data.machineId, observation);
  } catch (error) {
    // Redis already participates in readiness and signed-request replay defense;
    // compatibility persistence is diagnostic evidence, not an excuse to turn a
    // successfully authenticated heartbeat into a misleading transport failure.
    app.log.error({ err: error, machineId: body.data.machineId }, 'release_compatibility_store_failed');
  }

  const mode = releaseCompatibilityMode();
  if (mode === 'enforce' && !observation.compatible) {
    // Version skew is not a security quarantine. Keep the Agent alive for signed
    // diagnostics, power policy, STOP and cleanup, but make new rental work
    // impossible until a compatible heartbeat arrives.
    await db.$transaction([
      db.machine.updateMany({
        where: { id: body.data.machineId },
        data: { operational: MachineOperational.UNAVAILABLE },
      }),
      db.gpuListing.updateMany({
        where: { machineId: body.data.machineId, status: ListingStatus.ACTIVE },
        data: { status: ListingStatus.HIDDEN_OFFLINE },
      }),
    ]);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const base = payload as Record<string, unknown>;
  return {
    ...base,
    ...(mode === 'enforce' && !observation.compatible ? { publishable: false } : {}),
    releaseCompatibility: {
      mode,
      compatible: observation.compatible,
      reason: observation.reason,
      expected: observation.expected,
      reported: observation.reported,
    },
  };
}

export function registerReleaseCompatibilityRuntime(
  app: FastifyInstance,
  db: PrismaClient,
  redis: Redis,
): void {
  // Registered before server.ts declares /agent/heartbeat. preSerialization only
  // runs after that handler has authenticated/validated the heartbeat and produced
  // a successful payload, so an unauthenticated caller cannot poison compatibility.
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (request.routeOptions.url !== '/agent/heartbeat' || reply.statusCode >= 300) return payload;
    return observeSuccessfulHeartbeat(app, db, redis, request, payload);
  });

  // If an owner creates a listing after an incompatible heartbeat, server.ts may
  // initially classify it ACTIVE from freshness alone. Correct it before the 201
  // response leaves the process. Resource allocation independently rejects an
  // UNAVAILABLE machine, so this UI/catalogue correction is defense in depth.
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (
      releaseCompatibilityMode() !== 'enforce' ||
      request.method !== 'POST' ||
      request.routeOptions.url !== '/listings' ||
      reply.statusCode >= 300
    ) return payload;
    const body = z.object({ machineId: z.string().cuid() }).passthrough().safeParse(request.body);
    if (!body.success) return payload;
    const machine = await db.machine.findUnique({
      where: { id: body.data.machineId },
      select: { operational: true },
    });
    if (machine?.operational !== MachineOperational.UNAVAILABLE) return payload;
    await db.gpuListing.updateMany({
      where: { machineId: body.data.machineId, status: ListingStatus.ACTIVE },
      data: { status: ListingStatus.HIDDEN_OFFLINE },
    });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    return { ...(payload as Record<string, unknown>), status: ListingStatus.HIDDEN_OFFLINE };
  });

  app.get('/rental/machines/:machineId/release-compatibility', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const machine = await db.machine.findFirst({
      where: { id: machineId, ownerId: session.userId },
      select: { id: true, agentVersion: true, operational: true },
    });
    if (!machine) return reply.code(404).send({ error: 'machine_not_found' });
    const observation = await readReleaseCompatibilityObservation(redis, machineId);
    return {
      machineId,
      mode: releaseCompatibilityMode(),
      state: observation ? (observation.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE') : 'UNKNOWN',
      agentVersion: machine.agentVersion,
      operational: machine.operational,
      expected: releaseCompatibilityDescriptor(),
      reported: observation?.reported ?? null,
      reason: observation?.reason ?? 'release_compatibility_unknown',
      observedAt: observation?.observedAt ?? null,
    };
  });
}
