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
   * diagnostic result) or is a server-side computation over that data. */
  source: 'agent-heartbeat' | 'agent-diagnostic' | 'server';
};

/** Checks whose PASS is a mandatory precondition to lift a quarantine. Never
 * relaxed by a caller - see evaluateDiagnosticChecks. RAM/CPU are intentionally
 * excluded: those only affect per-workspace compatibility (machine-workspace-catalog.js),
 * never whether the machine itself is safe to unquarantine. */
const MANDATORY_CHECK_NAMES = ['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime'] as const;

const CHECK_NAME_TO_REASON_CODE: Record<string, QuarantineReasonCode> = {
  agent: QuarantineReasonCode.AGENT_SECURITY_FAILURE,
  gpu: QuarantineReasonCode.GPU_UNAVAILABLE,
  gpuUuid: QuarantineReasonCode.GPU_HEALTH_CHECK_FAILED,
  driver: QuarantineReasonCode.GPU_HEALTH_CHECK_FAILED,
  docker: QuarantineReasonCode.DOCKER_UNAVAILABLE,
  nvidiaRuntime: QuarantineReasonCode.NVIDIA_RUNTIME_UNAVAILABLE,
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
    const alreadyRunning = await tx.diagnosticRun.findFirst({
      where: { machineId: input.machineId, status: 'RUNNING' },
      select: { id: true, startedAt: true },
    });
    if (alreadyRunning) {
      const ageMs = Date.now() - alreadyRunning.startedAt.getTime();
      if (ageMs < DIAGNOSTIC_TIMEOUT_MS) return { run: alreadyRunning, alreadyRunning: true as const };
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
      await tx.diagnosticRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', checks: input.checks as unknown as Prisma.InputJsonValue, error: input.error.slice(0, 500), completedAt: now },
      });
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
    await tx.diagnosticRun.update({
      where: { id: run.id },
      data: { status: 'COMPLETED', checks: input.checks as unknown as Prisma.InputJsonValue, completedAt: now },
    });
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
