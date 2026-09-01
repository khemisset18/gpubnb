import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { requireSession } from './auth.js';
import { config } from './config.js';
import { constantTimeToken, verifyAgentRequest, verifyAgentRequestV2 } from './security.js';
import {
  DIAGNOSTIC_TIMEOUT_MS,
  completeDiagnosticRun,
  createDiagnosticRun,
  effectiveDiagnosticStatus,
  type DiagnosticCheck,
} from './diagnostic-run-service.js';
import { applyRepair, detectAvailableRepair, REPAIR_ACTIONS, type RepairActionCode } from './machine-repair-service.js';
import { clearQuarantine } from './quarantine-service.js';
import { reasonDefinition } from './quarantine-reason-registry.js';
import { computeMachineState } from './machine-state-service.js';
import { computeLifecycleStatus } from './rental-listing-service.js';
import { allWorkspaceCompatibility } from './machine-workspace-catalog.js';

/**
 * Authenticates an agent-signed request WITHOUT requiring
 * moderationStatus === CLEAR. Deliberately separate from the authenticateAgent
 * helpers in workspace-gateway.ts / rental-resource-routes.ts, which require
 * CLEAR by design for their own routes - the whole point of this module is
 * that a quarantined machine must still be able to prove its identity to run
 * a diagnostic. Never used to bypass quarantine: nothing this authenticates
 * can move moderationStatus back to CLEAR by itself (see quarantine-service.ts).
 */
async function authenticateQuarantinableAgent(
  db: PrismaClient,
  redis: Redis,
  machineId: string,
  request: FastifyRequest,
  routePath: string,
): Promise<boolean> {
  const machine = await db.machine.findUnique({
    where: { id: machineId },
    select: { agentPublicKey: true, keyRevokedAt: true },
  });
  if (!machine || machine.keyRevokedAt) return false;
  const versionHeader = request.headers['x-agent-signature-version'];
  const signatureVersion = Array.isArray(versionHeader) ? versionHeader[0] : versionHeader;
  if (signatureVersion === '2') {
    const bodyBytes = request.rawBody ?? Buffer.alloc(0);
    return verifyAgentRequestV2(redis, machineId, machine.agentPublicKey, request.method, routePath, bodyBytes, {
      timestamp: request.headers['x-agent-timestamp'],
      nonce: request.headers['x-agent-nonce'],
      bodySha256: request.headers['x-agent-body-sha256'],
      signature: request.headers['x-agent-signature-v2'],
      version: request.headers['x-agent-signature-version'],
    });
  }
  return verifyAgentRequest(
    redis, machineId, machine.agentPublicKey, request.method, routePath,
    request.headers['x-agent-timestamp'], request.headers['x-agent-signature'],
  );
}

const diagnosticResultSchema = z.object({
  machineId: z.string().cuid(),
  gpuDetected: z.boolean(),
  gpuUuid: z.string().max(200).nullable().optional(),
  driverVersion: z.string().max(80).nullable().optional(),
  summary: z.string().max(2000),
  metrics: z.record(z.unknown()).optional(),
  error: z.string().max(500).nullable().optional(),
}).strict();

async function buildChecksFromDiagnosticResult(
  db: PrismaClient,
  machineId: string,
  result: z.infer<typeof diagnosticResultSchema>,
  now: Date,
): Promise<DiagnosticCheck[]> {
  const machine = await db.machine.findUnique({
    where: { id: machineId },
    select: {
      dockerAvailable: true, nvidiaRuntimeAvailable: true, driverVersion: true,
      gpuUuid: true, cudaVersion: true, ramTotalMiB: true, lastHeartbeatAt: true,
    },
  });
  const heartbeatFresh = Boolean(
    machine?.lastHeartbeatAt &&
      now.getTime() - machine.lastHeartbeatAt.getTime() <= config.HEARTBEAT_OFFLINE_SECONDS * 1000,
  );
  const measuredAt = now.toISOString();

  const checks: DiagnosticCheck[] = [
    {
      name: 'agent',
      status: 'PASS', // reaching this handler already required a verified agent signature
      value: 'authentifié',
      details: 'La requête de résultat de diagnostic a une signature Ed25519 valide.',
      measuredAt,
      source: 'agent-diagnostic',
    },
    {
      name: 'gpu',
      status: result.gpuDetected ? 'PASS' : 'FAIL',
      value: result.summary.slice(0, 200),
      details: result.gpuDetected ? 'Le conteneur de diagnostic a détecté et utilisé le GPU.' : "Le conteneur de diagnostic n'a détecté aucun GPU utilisable.",
      measuredAt,
      source: 'agent-diagnostic',
    },
    {
      name: 'gpuUuid',
      status: result.gpuUuid ? 'PASS' : 'UNKNOWN',
      value: result.gpuUuid ?? null,
      details: result.gpuUuid ? "UUID matériel du GPU rapporté par l'agent." : "L'agent n'a rapporté aucun UUID GPU pour ce diagnostic.",
      measuredAt,
      source: 'agent-diagnostic',
    },
    {
      name: 'driver',
      status: (result.driverVersion || machine?.driverVersion) ? 'PASS' : 'UNKNOWN',
      value: result.driverVersion ?? machine?.driverVersion ?? null,
      details: 'Version du pilote GPU la plus récente connue.',
      measuredAt,
      source: result.driverVersion ? 'agent-diagnostic' : 'agent-heartbeat',
    },
    {
      name: 'docker',
      status: !heartbeatFresh ? 'UNKNOWN' : machine?.dockerAvailable ? 'PASS' : 'FAIL',
      value: machine?.dockerAvailable ? 'disponible' : 'indisponible',
      details: heartbeatFresh
        ? 'Dernier heartbeat agent utilisé (frais).'
        : "Dernier heartbeat trop ancien pour être considéré comme une preuve valide de l'état de Docker.",
      measuredAt,
      source: 'agent-heartbeat',
    },
    {
      name: 'nvidiaRuntime',
      status: !heartbeatFresh ? 'UNKNOWN' : machine?.nvidiaRuntimeAvailable ? 'PASS' : 'FAIL',
      value: machine?.nvidiaRuntimeAvailable ? 'disponible' : 'indisponible',
      details: heartbeatFresh
        ? 'Dernier heartbeat agent utilisé (frais).'
        : "Dernier heartbeat trop ancien pour être considéré comme une preuve valide du runtime NVIDIA.",
      measuredAt,
      source: 'agent-heartbeat',
    },
    {
      name: 'cuda',
      status: machine?.cudaVersion ? 'PASS' : 'WARNING',
      value: machine?.cudaVersion ?? null,
      details: 'Informationnel uniquement - n\'affecte pas la levée de quarantaine, seulement la compatibilité Workspace.',
      measuredAt,
      source: 'agent-heartbeat',
    },
    {
      name: 'ram',
      status: 'PASS',
      value: machine?.ramTotalMiB ? `${machine.ramTotalMiB} MiB` : null,
      details: "Informationnel uniquement - n'affecte pas la levée de quarantaine, seulement la compatibilité par type de Workspace (voir la section Compatibilité).",
      measuredAt,
      source: 'agent-heartbeat',
    },
  ];
  return checks;
}

export function registerMachineDiagnosticsRoutes(app: FastifyInstance, db: PrismaClient, redis: Redis): void {
  // --- Agent-facing: polled after every heartbeat, works while quarantined ---

  app.get('/agent/diagnostics/next/:machineId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const route = `/agent/diagnostics/next/${machineId}`;
    if (!await authenticateQuarantinableAgent(db, redis, machineId, request, route)) {
      return reply.code(401).send({ error: 'invalid_agent_request' });
    }
    const pending = await db.diagnosticRun.findFirst({
      where: { machineId, status: 'RUNNING' },
      orderBy: { startedAt: 'asc' },
      select: { id: true, startedAt: true, status: true },
    });
    if (!pending || effectiveDiagnosticStatus(pending) === 'TIMED_OUT') {
      return { diagnosticRunId: null };
    }
    return {
      diagnosticRunId: pending.id,
      diagnosticImage: config.DEV_DIAGNOSTIC_IMAGE ?? null,
      timeoutSeconds: Math.floor(DIAGNOSTIC_TIMEOUT_MS / 1000),
    };
  });

  app.post('/agent/diagnostics/:diagnosticRunId/result', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { diagnosticRunId } = z.object({ diagnosticRunId: z.string().cuid() }).parse(request.params);
    const body = diagnosticResultSchema.parse(request.body);
    const route = `/agent/diagnostics/${diagnosticRunId}/result`;
    if (!await authenticateQuarantinableAgent(db, redis, body.machineId, request, route)) {
      return reply.code(401).send({ error: 'invalid_agent_request' });
    }
    const run = await db.diagnosticRun.findUnique({ where: { id: diagnosticRunId }, select: { machineId: true, status: true } });
    if (!run || run.machineId !== body.machineId) return reply.code(404).send({ error: 'diagnostic_run_not_found' });
    if (run.status !== 'RUNNING') return reply.code(409).send({ error: 'diagnostic_run_not_running' });

    const now = new Date();
    if (body.error) {
      const outcome = await completeDiagnosticRun(db, {
        diagnosticRunId, machineId: body.machineId, checks: [], error: body.error, source: 'agent-diagnostic-result', now,
      });
      return { ok: true, status: outcome.status, cleared: outcome.cleared };
    }
    const checks = await buildChecksFromDiagnosticResult(db, body.machineId, body, now);
    const outcome = await completeDiagnosticRun(db, {
      diagnosticRunId, machineId: body.machineId, checks, source: 'agent-diagnostic-result', now,
    });
    return { ok: true, status: outcome.status, cleared: outcome.cleared, allMandatoryPass: outcome.evaluation?.allMandatoryPass ?? null };
  });

  // --- Owner-facing: Host "État & diagnostics" page ---

  async function requireOwnedMachine(request: FastifyRequest, reply: Parameters<typeof requireSession>[1], machineId: string) {
    const session = await requireSession(request, reply, redis);
    if (!session) return null;
    const machine = await db.machine.findFirst({ where: { id: machineId, ownerId: session.userId } });
    if (!machine) {
      reply.code(404).send({ error: 'machine_not_found' });
      return null;
    }
    return { session, machine };
  }

  app.get('/rental/machines/:machineId/diagnostics', async (request, reply) => {
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const owned = await requireOwnedMachine(request, reply, machineId);
    if (!owned) return;
    const { machine } = owned;
    const now = new Date();

    const [latestRun, history, repairAvailable, accelerators, listings, machineAllocations] = await Promise.all([
      db.diagnosticRun.findFirst({ where: { machineId }, orderBy: { startedAt: 'desc' } }),
      db.machineQuarantineEvent.findMany({ where: { machineId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      detectAvailableRepair(db, machineId),
      db.accelerator.findMany({ where: { machineId }, select: { status: true, moderationStatus: true, verifiedAt: true, driverVersion: true, lastSeenAt: true } }),
      db.gpuListing.findMany({ where: { machineId }, select: { status: true } }),
      db.machineAllocation.findMany({
        where: { machineId, releasedAt: null },
        select: { status: true, releasedAt: true, booking: { select: { status: true } } },
      }),
    ]);

    const heartbeatFresh = Boolean(
      machine.lastHeartbeatAt && now.getTime() - machine.lastHeartbeatAt.getTime() <= config.HEARTBEAT_OFFLINE_SECONDS * 1000,
    );
    const state = computeMachineState({
      agentPublicKey: machine.agentPublicKey,
      connectivity: machine.connectivity,
      operational: machine.operational,
      moderationStatus: machine.moderationStatus,
      quarantineReasonCode: machine.quarantineReasonCode,
      lastHeartbeatAt: machine.lastHeartbeatAt,
      lastCudaProbeOk: machine.lastCudaProbeOk,
      dockerAvailable: machine.dockerAvailable,
      nvidiaRuntimeAvailable: machine.nvidiaRuntimeAvailable,
      verifiedAt: machine.verifiedAt,
      heartbeatFresh,
      accelerators,
      listings,
      machineAllocations: machineAllocations.map((a) => ({ status: a.status, releasedAt: a.releasedAt, bookingStatus: a.booking.status })),
    });

    const isQuarantined = machine.moderationStatus === 'QUARANTINED';
    const quarantineReason = isQuarantined
      ? reasonDefinition((machine.quarantineReasonCode ?? 'UNKNOWN') as Parameters<typeof reasonDefinition>[0])
      : null;

    const compatibility = allWorkspaceCompatibility({
      ramTotalMiB: machine.ramTotalMiB, diskTotalMiB: machine.diskTotalMiB, vramMiB: machine.vramMiB,
      cudaVersion: machine.cudaVersion, dockerAvailable: machine.dockerAvailable, nvidiaRuntimeAvailable: machine.nvidiaRuntimeAvailable,
      operatingSystem: machine.operatingSystem, virtualizationAvailable: machine.virtualizationAvailable,
      desktopGpuRenderingAvailable: machine.desktopGpuRenderingAvailable,
    }).map((c) => ({ slug: c.slug, name: c.name, compatible: c.compatible, state: c.compatibility.state, missing: c.compatibility.missing }));

    return {
      machineId,
      state: { state: state.state, blockingReason: state.blockingReason, canPublish: state.canPublish, canAcceptBooking: state.canAcceptBooking },
      lifecycleStatus: computeLifecycleStatus(machine, now),
      quarantine: isQuarantined && quarantineReason ? {
        active: true,
        reasonCode: quarantineReason.code,
        title: quarantineReason.title,
        description: quarantineReason.description,
        severity: quarantineReason.severity,
        impact: quarantineReason.impact,
        since: machine.quarantinedAt,
      } : { active: false },
      lastHeartbeatAt: machine.lastHeartbeatAt,
      heartbeatFresh,
      lastDiagnosticAt: machine.lastDiagnosticAt,
      runningDiagnostic: latestRun && effectiveDiagnosticStatus(latestRun, now) === 'RUNNING'
        ? { id: latestRun.id, startedAt: latestRun.startedAt }
        : null,
      lastDiagnosticRun: latestRun ? {
        id: latestRun.id,
        status: effectiveDiagnosticStatus(latestRun, now),
        startedAt: latestRun.startedAt,
        completedAt: latestRun.completedAt,
        triggeredBy: latestRun.triggeredBy,
        checks: latestRun.checks,
        error: latestRun.error,
      } : null,
      repair: repairAvailable ? REPAIR_ACTIONS[repairAvailable] : null,
      compatibility,
      history: history.map((event) => ({
        id: event.id,
        status: event.status,
        reasonCode: event.reasonCode,
        reasonTitle: reasonDefinition(event.reasonCode).title,
        reason: event.reason,
        source: event.source,
        createdAt: event.createdAt,
        resolvedAt: event.resolvedAt,
        diagnosticRunId: event.diagnosticRunId,
        forced: Boolean((event.details as { forced?: boolean } | null)?.forced),
      })),
    };
  });

  app.post('/rental/machines/:machineId/diagnostics/rerun', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const owned = await requireOwnedMachine(request, reply, machineId);
    if (!owned) return;
    const { run, alreadyRunning } = await createDiagnosticRun(db, {
      machineId, triggeredBy: 'OWNER', triggeredById: owned.session.userId,
    });
    return reply.code(alreadyRunning ? 200 : 201).send({ diagnosticRunId: run.id, alreadyRunning });
  });

  app.post('/rental/machines/:machineId/diagnostics/repair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const owned = await requireOwnedMachine(request, reply, machineId);
    if (!owned) return;
    const available = await detectAvailableRepair(db, machineId);
    if (!available) return reply.code(409).send({ error: 'no_safe_repair_available' });
    const result = await applyRepair(db, machineId, available);
    request.log.warn({ machineId, ownerId: owned.session.userId, ...result }, 'machine_repair_applied');
    return { ok: true, ...result, nextAction: 'RUN_DIAGNOSTIC_TO_CONFIRM' };
  });

  app.post('/rental/machines/:machineId/retire', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(request.body ?? {});
    const owned = await requireOwnedMachine(request, reply, machineId);
    if (!owned) return;
    await db.machine.update({
      where: { id: machineId },
      data: { lifecycleStatus: 'RETIRED', retiredAt: new Date(), retiredReason: body.reason ?? null },
    });
    await db.gpuListing.updateMany({
      where: { machineId, status: { in: ['ACTIVE', 'RESERVED', 'PAUSED', 'PENDING_GPU_VERIFICATION'] } },
      data: { status: 'PAUSED' },
    });
    return { ok: true, lifecycleStatus: 'RETIRED' };
  });

  app.post('/rental/machines/:machineId/reactivate', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const owned = await requireOwnedMachine(request, reply, machineId);
    if (!owned) return;
    await db.machine.update({
      where: { id: machineId },
      data: { lifecycleStatus: 'ACTIVE', retiredAt: null, retiredReason: null },
    });
    return { ok: true, lifecycleStatus: 'ACTIVE' };
  });

  // --- Admin-only, heavily gated: forced quarantine clear ---

  app.post('/internal/machines/:machineId/quarantine/force-clear', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!constantTimeToken(request.headers.authorization?.replace(/^Bearer\s+/i, ''), config.INTERNAL_SERVICE_TOKEN)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const body = z.object({ operatorId: z.string().min(1).max(200), reason: z.string().min(1).max(500) }).parse(request.body);
    const machine = await db.machine.findUnique({ where: { id: machineId }, select: { moderationStatus: true, quarantineReasonCode: true } });
    if (!machine) return reply.code(404).send({ error: 'machine_not_found' });
    if (machine.moderationStatus !== 'QUARANTINED') return reply.code(409).send({ error: 'machine_not_quarantined' });
    const latestRun = await db.diagnosticRun.findFirst({ where: { machineId }, orderBy: { startedAt: 'desc' } });
    await db.$transaction((tx) => clearQuarantine(tx, {
      machineId,
      reason: `Sortie de quarantaine forcée par un administrateur : ${body.reason}`,
      source: 'internal.force-clear',
      forcedByAdminId: body.operatorId,
      details: { previousReasonCode: machine.quarantineReasonCode, lastDiagnosticRunId: latestRun?.id ?? null, lastDiagnosticStatus: latestRun?.status ?? null },
    }));
    request.log.warn({ machineId, operatorId: body.operatorId, reason: body.reason }, 'FORCED_QUARANTINE_CLEAR');
    return { ok: true, machineId, moderationStatus: 'CLEAR' };
  });
}

export type { RepairActionCode };
