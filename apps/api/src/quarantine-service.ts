import { Prisma, AcceleratorOperationalStatus, ModerationStatus, QuarantineReasonCode } from '@prisma/client';

function jsonOrNull(details: Record<string, unknown> | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return details === undefined ? Prisma.JsonNull : (details as Prisma.InputJsonValue);
}

export type EnterQuarantineInput = {
  machineId: string;
  reasonCode: QuarantineReasonCode;
  reason: string;
  details?: Record<string, unknown>;
  /** Which subsystem made this decision, e.g. 'accelerator-security-executor',
   * 'job-staleness-sweep', 'agent-heartbeat'. Free text, for the history view. */
  source: string;
  now?: Date;
};

/**
 * Records that a machine is now quarantined, for whichever reasonCode applies.
 * Idempotent with respect to Machine.moderationStatus (safe to call again on an
 * already-quarantined machine - each call still appends a durable history row,
 * as ENTERED the first time and REENTERED afterwards, and quarantinedAt is only
 * set on the first transition so it always reflects when the *current*
 * continuous quarantine period actually began).
 *
 * Must be called from inside the caller's own transaction so the Machine update
 * and the history row are atomic with whatever else that transaction is doing.
 */
export async function enterQuarantine(tx: Prisma.TransactionClient, input: EnterQuarantineInput): Promise<void> {
  const now = input.now ?? new Date();
  const machine = await tx.machine.findUnique({
    where: { id: input.machineId },
    select: { moderationStatus: true, quarantinedAt: true },
  });
  if (!machine) return;
  const alreadyQuarantined = machine.moderationStatus === ModerationStatus.QUARANTINED;

  await tx.machine.update({
    where: { id: input.machineId },
    data: {
      moderationStatus: ModerationStatus.QUARANTINED,
      quarantineReasonCode: input.reasonCode,
      ...(alreadyQuarantined ? {} : { quarantinedAt: now }),
    },
  });
  // Mirror onto Accelerator immediately rather than waiting for the next
  // heartbeat's inventory sync - see the matching comment in clearQuarantine().
  // Without this, rental-gpu-catalog.ts / rental-public-listings.ts could show
  // an accelerator as healthy for up to one heartbeat interval after its
  // Machine was already quarantined (Machine=QUARANTINED, Accelerator=CLEAR is
  // exactly the contradictory state this system must never allow).
  await tx.accelerator.updateMany({
    where: { machineId: input.machineId, moderationStatus: { not: ModerationStatus.QUARANTINED } },
    data: { moderationStatus: ModerationStatus.QUARANTINED },
  });
  await tx.accelerator.updateMany({
    where: { machineId: input.machineId, status: { not: AcceleratorOperationalStatus.QUARANTINED } },
    data: { status: AcceleratorOperationalStatus.QUARANTINED },
  });

  await tx.machineQuarantineEvent.create({
    data: {
      machineId: input.machineId,
      status: alreadyQuarantined ? 'REENTERED' : 'ENTERED',
      reasonCode: input.reasonCode,
      reason: input.reason,
      details: jsonOrNull(input.details),
      source: input.source,
      createdAt: now,
    },
  });
}

export type RecordDiagnosticEventInput = {
  machineId: string;
  diagnosticRunId: string;
  reasonCode: QuarantineReasonCode;
  reason: string;
  details?: Record<string, unknown>;
  source: string;
  now?: Date;
};

/** Appends a DIAGNOSTIC history row without changing Machine.moderationStatus.
 * Used for "diagnostic started" / "diagnostic ran but did not clear the
 * quarantine" entries, so the timeline reads as a real sequence of events. */
export async function recordDiagnosticEvent(
  tx: Prisma.TransactionClient,
  input: RecordDiagnosticEventInput,
): Promise<void> {
  await tx.machineQuarantineEvent.create({
    data: {
      machineId: input.machineId,
      status: 'DIAGNOSTIC',
      reasonCode: input.reasonCode,
      reason: input.reason,
      details: jsonOrNull(input.details),
      source: input.source,
      diagnosticRunId: input.diagnosticRunId,
      createdAt: input.now ?? new Date(),
    },
  });
}

export type ClearQuarantineInput = {
  machineId: string;
  /** Absent only for an ADMIN forced clear with no successful diagnostic - see forcedByAdminId. */
  diagnosticRunId?: string;
  reason: string;
  details?: Record<string, unknown>;
  source: string;
  /** ADMIN forced clears must say so explicitly in the history - never hide a
   * forced clear as an ordinary diagnostic-driven one. */
  forcedByAdminId?: string;
  now?: Date;
};

/**
 * The only function in this codebase allowed to move a machine's
 * moderationStatus back to CLEAR. Every call site must have already verified
 * (via diagnostic-run-service.evaluateDiagnosticChecks, or an explicit admin
 * override with its own audit trail) that this is a real, evidenced decision -
 * never call this directly from a route handler on request input alone.
 */
export async function clearQuarantine(tx: Prisma.TransactionClient, input: ClearQuarantineInput): Promise<void> {
  const machine = await tx.machine.findUnique({
    where: { id: input.machineId },
    select: { quarantineReasonCode: true },
  });
  const now = input.now ?? new Date();
  await tx.machine.update({
    where: { id: input.machineId },
    data: {
      moderationStatus: ModerationStatus.CLEAR,
      quarantineReasonCode: null,
      quarantinedAt: null,
    },
  });
  // Accelerator.moderationStatus AND Accelerator.status=QUARANTINED are, in this
  // codebase, only ever a mirror of its Machine's own moderationStatus at the
  // last inventory sync (see mining-resource-inventory.ts's
  // syncGpuMiningResourcesFromAccelerators / legacyGpuStatus - no code path
  // quarantines an Accelerator independently of its Machine). Left alone, an
  // accelerator quarantined by a previous sync would only catch up on the *next*
  // heartbeat, leaving rental-gpu-catalog.ts's computeRentalGpuReadiness reporting
  // ACCELERATOR_QUARANTINED for up to one heartbeat interval after the machine
  // itself was actually cleared. Reset to AVAILABLE, the common case the next
  // real heartbeat will otherwise recompute anyway via legacyGpuStatus.
  await tx.accelerator.updateMany({
    where: { machineId: input.machineId, moderationStatus: ModerationStatus.QUARANTINED },
    data: { moderationStatus: ModerationStatus.CLEAR },
  });
  await tx.accelerator.updateMany({
    where: { machineId: input.machineId, status: AcceleratorOperationalStatus.QUARANTINED },
    data: { status: AcceleratorOperationalStatus.AVAILABLE },
  });
  await tx.machineQuarantineEvent.updateMany({
    where: { machineId: input.machineId, resolvedAt: null, status: { in: ['ENTERED', 'REENTERED'] } },
    data: { resolvedAt: now },
  });
  await tx.machineQuarantineEvent.create({
    data: {
      machineId: input.machineId,
      status: 'CLEARED',
      reasonCode: machine?.quarantineReasonCode ?? QuarantineReasonCode.UNKNOWN,
      reason: input.reason,
      details: {
        ...(input.details ?? {}),
        ...(input.forcedByAdminId ? { forcedByAdminId: input.forcedByAdminId, forced: true } : {}),
      } as Prisma.InputJsonValue,
      source: input.source,
      diagnosticRunId: input.diagnosticRunId ?? null,
      createdAt: now,
      resolvedAt: now,
    },
  });
}
