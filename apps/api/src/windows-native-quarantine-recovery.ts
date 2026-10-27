import { WorkspaceSessionStatus, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { DIAGNOSTIC_TIMEOUT_MS } from './diagnostic-run-service.js';
import { resourceFenceKey, resourceLeaseKey } from './resource-lease.js';

const liveAllocations = ['HELD', 'CONFIRMED', 'ACTIVE'] as const;
const terminalSessions = new Set<WorkspaceSessionStatus>([
  WorkspaceSessionStatus.COMPLETED, WorkspaceSessionStatus.FAILED,
  WorkspaceSessionStatus.CANCELLED, WorkspaceSessionStatus.TIMED_OUT,
  WorkspaceSessionStatus.QUARANTINED,
]);
const resourceId = z.string().regex(/^[A-Za-z0-9_.:-]{8,160}$/);
const gpuUuid = z.string().regex(/^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const generationPattern = /^[1-9]\d{0,18}$/;
const generation = z.string().regex(generationPattern).refine(value =>
  generationPattern.test(value) && BigInt(value) <= 9223372036854775807n);

export const nativeCleanupAuthorityRequestSchema = z.object({
  machineId: z.string().cuid(), sessionId: z.string().cuid(),
  resourceId, hardwareUuid: gpuUuid, runtimeGeneration: generation,
}).strict();

export const nativeRuntimeCleanupSchema = z.object({
  protocolVersion: z.literal(1), sessionId: z.string().cuid(), resourceId,
  hardwareUuid: gpuUuid, fenceFloor: generation,
  helperStopped: z.boolean(), gpuQuiescent: z.boolean(),
  remainingRentalResourceIds: z.array(resourceId).max(64),
  unsafeRuntimeResourceIds: z.array(resourceId).max(64),
}).strict();

export type NativeCleanupTarget = { sessionId: string; resourceId: string; hardwareUuid: string };
export type NativeCleanupContext = { required: boolean; target: NativeCleanupTarget | null };

/** A native cleanup quarantine cannot be cleared with Docker inventory alone. */
export async function nativeCleanupContext(db: PrismaClient, machineId: string): Promise<NativeCleanupContext> {
  const machine = await db.machine.findUnique({
    where: { id: machineId }, select: { moderationStatus: true, quarantineReasonCode: true },
  });
  if (machine?.moderationStatus !== 'QUARANTINED') {
    return { required: false, target: null };
  }
  const history = await db.workspaceSession.findFirst({
    where: { machineId, runtimeBackend: 'WINDOWS_NATIVE' }, select: { id: true },
  });
  if (!history) return { required: false, target: null };
  const events = await db.machineQuarantineEvent.findMany({
    where: { machineId, reasonCode: 'WORKSPACE_CLEANUP_FAILED', resolvedAt: null,
      source: 'workspace-gateway.stopped', status: { in: ['ENTERED', 'REENTERED'] } },
    orderBy: { createdAt: 'desc' }, select: { details: true }, take: 65,
  });
  // A failed diagnostic can change the primary reason (e.g. Docker unavailable).
  // The unresolved native cleanup obligation survives until clearQuarantine
  // resolves the quarantine events; it must not disappear with that reason.
  if (!events.length && machine.quarantineReasonCode !== 'WORKSPACE_CLEANUP_FAILED') {
    return { required: false, target: null };
  }
  if (!events.length || events.length > 64) return { required: true, target: null };
  const sessionIds = new Set<string>();
  for (const event of events) {
    const details = event.details;
    const sessionId = details && typeof details === 'object' && !Array.isArray(details) ? details.sessionId : null;
    if (typeof sessionId !== 'string') return { required: true, target: null };
    sessionIds.add(sessionId);
  }
  const sessions = await db.workspaceSession.findMany({
    where: { id: { in: [...sessionIds] }, machineId },
    select: { id: true, runtimeBackend: true, booking: { select: { acceleratorAllocations: { select: {
      accelerator: { select: { machineId: true, hardwareUuid: true, vendor: true,
        miningResource: { select: { id: true, kind: true } } } },
    } } } } },
  });
  if (sessions.length !== sessionIds.size) return { required: true, target: null };
  const native = sessions.filter(session => session.runtimeBackend === 'WINDOWS_NATIVE');
  if (!native.length) return { required: false, target: null };
  // One later Docker stop must not hide an earlier unresolved native cleanup.
  // Multiple native obligations require explicit investigation, not an arbitrary
  // choice of session to STOP. Repeated events for the same session deduplicate.
  if (native.length !== 1) return { required: true, target: null };
  const session = native[0]!;
  // Qualification currently admits exactly one selected NVIDIA accelerator.
  // Unknown/full-machine historical mappings stay blocked rather than guessed.
  const allocations = session?.booking.acceleratorAllocations ?? [];
  const accelerator = allocations.length === 1 ? allocations[0]?.accelerator : null;
  if (!accelerator || accelerator.machineId !== machineId || accelerator.vendor?.toLowerCase() !== 'nvidia'
    || accelerator.miningResource?.kind !== 'GPU' || !gpuUuid.safeParse(accelerator.hardwareUuid).success) {
    return { required: true, target: null };
  }
  return { required: true, target: {
    sessionId: session.id, resourceId: accelerator.miningResource.id, hardwareUuid: accelerator.hardwareUuid,
  } };
}

const READ_CLEANUP_FENCE = `
local floor = redis.call('GET', KEYS[2]) or ''
local busy = redis.call('EXISTS', KEYS[1])
return {floor, busy}
`;

export type NativeCleanupDecision = NativeCleanupTarget & {
  protocolVersion: 1; diagnosticRunId: string; allowed: boolean;
  fenceFloor?: string; reason?: string;
};

/** Read-only authorization: no booking, lease, generation or moderation mutation. */
export async function authorizeNativeQuarantineCleanup(
  db: PrismaClient, redis: Redis, diagnosticRunId: string,
  input: z.infer<typeof nativeCleanupAuthorityRequestSchema>, now = new Date(),
): Promise<NativeCleanupDecision> {
  const base = { protocolVersion: 1 as const, diagnosticRunId,
    sessionId: input.sessionId, resourceId: input.resourceId, hardwareUuid: input.hardwareUuid };
  const deny = (reason: string): NativeCleanupDecision => ({ ...base, allowed: false, reason });
  const run = await db.diagnosticRun.findFirst({
    where: { id: diagnosticRunId, machineId: input.machineId },
    select: { status: true, triggeredBy: true, startedAt: true },
  });
  if (!run || run.status !== 'RUNNING' || !['OWNER', 'ADMIN'].includes(run.triggeredBy)
    || run.startedAt > now || now.getTime() - run.startedAt.getTime() > DIAGNOSTIC_TIMEOUT_MS) {
    return deny('native_cleanup_diagnostic_not_authorized');
  }
  const context = await nativeCleanupContext(db, input.machineId);
  const target = context.target;
  if (!context.required || !target || target.sessionId !== input.sessionId
    || target.resourceId !== input.resourceId || target.hardwareUuid.toLowerCase() !== input.hardwareUuid.toLowerCase()) {
    return deny('native_cleanup_scope_unverified');
  }
  const session = await db.workspaceSession.findFirst({
    where: { id: input.sessionId, machineId: input.machineId, runtimeBackend: 'WINDOWS_NATIVE' },
    select: { status: true, endedAt: true },
  });
  if (!session || !terminalSessions.has(session.status) || session.endedAt === null || session.endedAt > now) {
    return deny('native_cleanup_session_not_terminal');
  }
  const [allocation, fullMachine, liveSession, resource] = await Promise.all([
    db.acceleratorAllocation.findFirst({ where: { accelerator: { machineId: input.machineId },
      status: { in: [...liveAllocations] } }, select: { id: true } }),
    db.machineAllocation.findFirst({ where: { machineId: input.machineId,
      status: { in: [...liveAllocations] } }, select: { id: true } }),
    db.workspaceSession.findFirst({ where: { machineId: input.machineId, endedAt: null,
      status: { in: ['PREPARING', 'READY', 'RUNNING', 'STOP_REQUESTED', 'STOPPING'] } }, select: { id: true } }),
    db.miningResource.findFirst({ where: { id: input.resourceId, machineId: input.machineId },
      select: { quarantined: true, runtimeState: true, activeRentalId: true } }),
  ]);
  if (allocation || fullMachine || liveSession) return deny('native_cleanup_live_work_present');
  if (!resource || resource.quarantined || resource.runtimeState !== 'IDLE' || resource.activeRentalId !== null) {
    return deny('native_cleanup_resource_authority_busy');
  }
  try {
    // The lease key and persistent fence are read atomically, in the same Redis slot.
    // Even a malformed/persistent lease key is busy. Never synthesize a lost fence.
    const raw = await redis.eval(READ_CLEANUP_FENCE, 2, resourceLeaseKey(input.resourceId), resourceFenceKey(input.resourceId));
    if (!Array.isArray(raw) || raw.length !== 2 || raw[1] !== 0) return deny('native_cleanup_resource_lease_busy');
    const floor = generation.safeParse(raw[0]);
    if (!floor.success || BigInt(floor.data) < BigInt(input.runtimeGeneration)) return deny('native_cleanup_fence_unverified');
    return { ...base, allowed: true, fenceFloor: floor.data };
  } catch { return deny('native_cleanup_authority_unavailable'); }
}

export async function verifyNativeCleanupReport(
  db: PrismaClient, redis: Redis, diagnosticRunId: string, machineId: string,
  report: z.infer<typeof nativeRuntimeCleanupSchema> | undefined, signedV2: boolean, now: Date,
): Promise<'PASS' | 'FAIL' | 'UNKNOWN'> {
  if (!report || !signedV2) return 'UNKNOWN';
  if (!report.helperStopped || !report.gpuQuiescent
    || report.remainingRentalResourceIds.length || report.unsafeRuntimeResourceIds.length) return 'FAIL';
  const decision = await authorizeNativeQuarantineCleanup(db, redis, diagnosticRunId, {
    machineId, sessionId: report.sessionId, resourceId: report.resourceId,
    hardwareUuid: report.hardwareUuid, runtimeGeneration: report.fenceFloor,
  }, now);
  return decision.allowed && decision.fenceFloor === report.fenceFloor ? 'PASS' : 'UNKNOWN';
}
