import type { Prisma, PrismaClient } from '@prisma/client';
import { DiagnosticTrigger, QuarantineReasonCode } from '@prisma/client';
import { clearQuarantine, enterQuarantine, recordDiagnosticEvent } from './quarantine-service.js';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARNING' | 'UNKNOWN' | 'NOT_CHECKED';

export type DiagnosticCheck = {
  name: string;
  status: CheckStatus;
  value: string | null;
  details: string;
  measuredAt: string;
  /** Where this value actually came from - never 'browser'. Every check here is
   * either derived from the authenticated agent's own report (heartbeat or
   * diagnostic result) or is a server-side computation over data the agent
   * reported (never invented). */
  source: 'agent-heartbeat' | 'agent-diagnostic' | 'server';
};

/** Checks whose PASS is a mandatory precondition to lift a quarantine. Never
 * relaxed by a caller - see evaluateDiagnosticChecks. RAM/CPU are intentionally
 * excluded: those only affect per-workspace compatibility (machine-workspace-catalog.js),
 * never whether the machine itself is safe to unquarantine. 'allocation' is
 * mandatory because a machine with a real orphaned GPU allocation is not safe
 * to republish even if the GPU hardware itself checks out. */
const MANDATORY_CHECK_NAMES = ['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'allocation'] as const;

const CHECK_NAME_TO_REASON_CODE: Record<string, QuarantineReasonCode> = {
  agent: QuarantineReasonCode.AGENT_SECURITY_FAILURE,
  gpu: QuarantineReasonCode.GPU_UNAVAILABLE,
  gpuUuid: QuarantineReasonCode.GPU_HEALTH_CHECK_FAILED,
  driver: QuarantineReasonCode.GPU_HEALTH_CHECK_FAILED,
  docker: QuarantineReasonCode.DOCKER_UNAVAILABLE,
  nvidiaRuntime: QuarantineReasonCode.NVIDIA_RUNTIME_UNAVAILABLE,
  allocation: QuarantineReasonCode.ORPHANED_ALLOCATION,
};

export type DiagnosticEvaluation = {
  allMandatoryPass: boolean;
  failingChecks: DiagnosticCheck[];
  /** The reasonCode to use if the quarantine is maintained/re-entered - the
   * first failing mandatory check, in MANDATORY_CHECK_NAMES order. */
  reasonCode: QuarantineReasonCode;
};

/**
 * Never treats UNKNOWN or NOT_CHECKED as PASS - a check that could not be
 * evaluated is exactly as blocking as one that failed outright, since neither
 * proves the machine safe.
 */
export function evaluateDiagnosticChecks(checks: DiagnosticCheck[]): DiagnosticEvaluation {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const failingChecks: DiagnosticCheck[] = [];
  for (const name of MANDATORY_CHECK_NAMES) {
    const check = byName.get(name);
    if (!check || check.status !== 'PASS') {
      failingChecks.push(
        check ?? { name, status: 'NOT_CHECKED', value: null, details: 'Aucune donnée pour ce contrôle.', measuredAt: new Date().toISOString(), source: 'server' },
      );
    }
  }
  const firstFailing = failingChecks[0];
  const reasonCode = firstFailing
    ? (CHECK_NAME_TO_REASON_CODE[firstFailing.name] ?? QuarantineReasonCode.UNKNOWN)
    : QuarantineReasonCode.UNKNOWN;
  return { allMandatoryPass: failingChecks.length === 0, failingChecks, reasonCode };
}

export type CreateDiagnosticRunInput = {
  machineId: string;
  triggeredBy: DiagnosticTrigger;
  triggeredById?: string;
};

export async function createDiagnosticRun(db: PrismaClient, input: CreateDiagnosticRunInput) {
  return db.$transaction(async (tx) => {
    // Serializes concurrent create attempts for the same machine (two rapid
    // clicks on "Relancer le diagnostic", or the owner and an automated system
    // triggering one at the same moment) - without this, two RUNNING rows could
    // both pass the findFirst check below before either commits, and the agent's
    // GET next (newest-first, see machine-diagnostics-routes.ts) could then work
    // on a different run than the one Host shows as "current". Same lock-key
    // convention as resource-allocation-service.ts / rental-listing-service.ts.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.machineId}, 1))`;
    // Sweep every stale RUNNING row for this machine first - status='RUNNING'
    // never gets rewritten to TIMED_OUT on its own (only a poll/result
    // submission does that, see machine-diagnostics-routes.ts), so without
    // this a long-dead run could either wrongly report alreadyRunning, or
    // simply accumulate as a permanent zombie row once the real new run below
    // is created.
    const now = new Date();
    const cutoff = new Date(now.getTime() - DIAGNOSTIC_TIMEOUT_MS);
    await tx.diagnosticRun.updateMany({
      where: { machineId: input.machineId, status: 'RUNNING', startedAt: { lt: cutoff } },
      data: { status: 'TIMED_OUT', completedAt: now, error: 'agent_never_reported_result' },
    });
    const alreadyRunning = await tx.diagnosticRun.findFirst({
      where: { machineId: input.machineId, status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (alreadyRunning) {
      return { run: alreadyRunning, alreadyRunning: true as const };
    }
    const run = await tx.diagnosticRun.create({
      data: {
        machineId: input.machineId,
        status: 'RUNNING',
        triggeredBy: input.triggeredBy,
        triggeredById: input.triggeredById ?? null,
      },
    });
    await recordDiagnosticEvent(tx, {
      machineId: input.machineId,
      diagnosticRunId: run.id,
      reasonCode: QuarantineReasonCode.UNKNOWN,
      reason: `Diagnostic lancé (${input.triggeredBy === 'OWNER' ? 'par le propriétaire' : input.triggeredBy === 'ADMIN' ? 'par un administrateur' : 'automatiquement'}).`,
      source: 'diagnostic-run-service.create',
    });
    return { run, alreadyRunning: false as const };
  });
}

/** A RUNNING diagnostic the agent never reported back on (crashed, network loss,
 * machine went offline mid-run) is surfaced as TIMED_OUT rather than left stuck
 * RUNNING forever - computed lazily from real timestamps, never assumed. */
export const DIAGNOSTIC_TIMEOUT_MS = 3 * 60_000;

export function effectiveDiagnosticStatus(run: { status: string; startedAt: Date }, now = new Date()): string {
  if (run.status === 'RUNNING' && now.getTime() - run.startedAt.getTime() > DIAGNOSTIC_TIMEOUT_MS) {
    return 'TIMED_OUT';
  }
  return run.status;
}

export type CompleteDiagnosticRunInput = {
  diagnosticRunId: string;
  machineId: string;
  checks: DiagnosticCheck[];
  error?: string;
  source: string;
  now?: Date;
};

export type CompleteDiagnosticRunResult = {
  status: 'COMPLETED' | 'FAILED';
  cleared: boolean;
  evaluation: DiagnosticEvaluation | null;
};

/**
 * The only place allowed to decide whether a diagnostic clears a quarantine.
 * error set (agent could not run the diagnostic at all) => FAILED, quarantine
 * maintained/re-entered with the reason the machine already had. Otherwise the
 * run COMPLETED (it executed) and evaluateDiagnosticChecks decides clear vs.
 * maintain from the actual check results - never from the mere fact the agent
 * responded.
 */
/** Thrown when a diagnostic result arrives for a run that is no longer RUNNING -
 * a concurrent/duplicate submission (agent retry racing itself, or a replayed
 * request) lost the atomic claim below. The route layer maps this to 409;
 * never treated as a 500, and never silently reapplies the outcome twice. */
export class DiagnosticRunConflictError extends Error {
  constructor() {
    super('diagnostic_run_already_completed');
    this.name = 'DiagnosticRunConflictError';
  }
}

export async function completeDiagnosticRun(
  db: PrismaClient,
  input: CompleteDiagnosticRunInput,
): Promise<CompleteDiagnosticRunResult> {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    const run = await tx.diagnosticRun.findUnique({ where: { id: input.diagnosticRunId } });
    if (!run || run.machineId !== input.machineId) throw new Error('diagnostic_run_not_found');

    const machine = await tx.machine.findUnique({
      where: { id: input.machineId },
      select: { moderationStatus: true, quarantineReasonCode: true },
    });
    const wasQuarantined = machine?.moderationStatus === 'QUARANTINED';

    if (input.error) {
      // Atomic claim: only the request that actually transitions RUNNING -> FAILED
      // proceeds to apply quarantine side-effects. A second, racing submission for
      // the same run (agent retry after a lost response, or a replay) finds
      // count===0 and must not reapply enterQuarantine() a second time.
      const claimed = await tx.diagnosticRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: { status: 'FAILED', checks: input.checks as unknown as Prisma.InputJsonValue, error: input.error.slice(0, 500), completedAt: now },
      });
      if (claimed.count !== 1) throw new DiagnosticRunConflictError();
      await tx.machine.update({ where: { id: input.machineId }, data: { lastDiagnosticRunId: run.id, lastDiagnosticAt: now } });
      if (wasQuarantined) {
        await enterQuarantine(tx, {
          machineId: input.machineId,
          reasonCode: machine!.quarantineReasonCode ?? QuarantineReasonCode.UNKNOWN,
          reason: `Le diagnostic n'a pas pu s'exécuter : ${input.error.slice(0, 300)}`,
          details: { diagnosticRunId: run.id },
          source: input.source,
          now,
        });
      }
      return { status: 'FAILED', cleared: false, evaluation: null };
    }

    const evaluation = evaluateDiagnosticChecks(input.checks);
    // Same atomic claim as the FAILED branch above - see DiagnosticRunConflictError.
    const claimed = await tx.diagnosticRun.updateMany({
      where: { id: run.id, status: 'RUNNING' },
      data: { status: 'COMPLETED', checks: input.checks as unknown as Prisma.InputJsonValue, completedAt: now },
    });
    if (claimed.count !== 1) throw new DiagnosticRunConflictError();
    await tx.machine.update({ where: { id: input.machineId }, data: { lastDiagnosticRunId: run.id, lastDiagnosticAt: now } });

    if (evaluation.allMandatoryPass) {
      if (wasQuarantined) {
        await clearQuarantine(tx, {
          machineId: input.machineId,
          diagnosticRunId: run.id,
          reason: 'Diagnostic réussi : tous les critères obligatoires (agent, GPU, pilote, Docker, runtime NVIDIA) sont satisfaits.',
          details: { checks: input.checks },
          source: input.source,
          now,
        });
      } else {
        await recordDiagnosticEvent(tx, {
          machineId: input.machineId,
          diagnosticRunId: run.id,
          reasonCode: QuarantineReasonCode.UNKNOWN,
          reason: 'Diagnostic réussi : tous les critères obligatoires sont satisfaits.',
          details: { checks: input.checks },
          source: input.source,
          now,
        });
      }
      return { status: 'COMPLETED', cleared: wasQuarantined, evaluation };
    }

    const failingNames = evaluation.failingChecks.map((c) => c.name).join(', ');
    await enterQuarantine(tx, {
      machineId: input.machineId,
      reasonCode: evaluation.reasonCode,
      reason: `Diagnostic terminé : au moins un critère obligatoire n'est pas satisfait (${failingNames}). Quarantaine maintenue.`,
      details: { checks: input.checks, diagnosticRunId: run.id },
      source: input.source,
      now,
    });
    return { status: 'COMPLETED', cleared: false, evaluation };
  });
}
