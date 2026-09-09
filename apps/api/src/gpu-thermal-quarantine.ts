import {
  MachineOperational,
  ModerationStatus,
  QuarantineReasonCode,
  type Prisma,
} from '@prisma/client';

import type { AcceleratorTelemetry } from './accelerator-telemetry.js';
import { enterQuarantine, recordDiagnosticEvent } from './quarantine-service.js';

/**
 * Product invariant: temperature alone never puts a machine in server-side
 * quarantine below 98 C. Local workload protection may stop or throttle work
 * earlier; that is deliberately a different state from quarantine.
 */
export const GPU_THERMAL_QUARANTINE_CELSIUS = 98;

/**
 * Hysteresis for automatic recovery. A thermal quarantine is not revalidated
 * while the GPU is still close to the trip point; a fresh diagnostic is queued
 * automatically only after a real heartbeat proves <= 90 C.
 */
export const GPU_THERMAL_RECOVERY_CELSIUS = 90;
export const GPU_THERMAL_SUBREASON = 'GPU_THERMAL_LIMIT_REACHED' as const;

export type GpuThermalObservation = {
  hardwareUuid: string;
  temperatureC: number;
};

export type GpuThermalEnforcement = {
  observation: GpuThermalObservation | null;
  blocking: boolean;
  quarantineEntered: boolean;
  recoveryDiagnosticRunId: string | null;
};

export type GpuThermalRecoveryStatus = {
  active: boolean;
  ready: boolean;
  temperatureC: number | null;
  measuredAt: Date | null;
};

export function hottestGpuTemperature(
  accelerators: readonly AcceleratorTelemetry[],
): GpuThermalObservation | null {
  let hottest: GpuThermalObservation | null = null;
  for (const accelerator of accelerators) {
    if (accelerator.kind !== 'GPU' || accelerator.temperatureC == null || !Number.isFinite(accelerator.temperatureC)) {
      continue;
    }
    if (!hottest || accelerator.temperatureC > hottest.temperatureC) {
      hottest = {
        hardwareUuid: accelerator.deviceId,
        temperatureC: accelerator.temperatureC,
      };
    }
  }
  return hottest;
}

async function activeThermalQuarantineEvent(
  tx: Prisma.TransactionClient,
  machineId: string,
) {
  return tx.machineQuarantineEvent.findFirst({
    where: {
      machineId,
      resolvedAt: null,
      source: 'accelerator-heartbeat.thermal',
      status: { in: ['ENTERED', 'REENTERED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  });
}

export async function gpuThermalRecoveryStatus(
  tx: Prisma.TransactionClient,
  machineId: string,
): Promise<GpuThermalRecoveryStatus> {
  const active = await activeThermalQuarantineEvent(tx, machineId);
  if (!active) {
    return { active: false, ready: true, temperatureC: null, measuredAt: null };
  }

  const latestHeartbeat = await tx.heartbeat.findFirst({
    where: { machineId },
    orderBy: { receivedAt: 'desc' },
    select: { temperatureC: true, receivedAt: true },
  });
  if (!latestHeartbeat) {
    return { active: true, ready: false, temperatureC: null, measuredAt: null };
  }
  return {
    active: true,
    ready: latestHeartbeat.temperatureC <= GPU_THERMAL_RECOVERY_CELSIUS,
    temperatureC: latestHeartbeat.temperatureC,
    measuredAt: latestHeartbeat.receivedAt,
  };
}

async function queueAutomaticThermalRecoveryDiagnostic(
  tx: Prisma.TransactionClient,
  machineId: string,
  observation: GpuThermalObservation,
  now: Date,
): Promise<string | null> {
  if (observation.temperatureC > GPU_THERMAL_RECOVERY_CELSIUS) return null;

  const [activeThermal, machine] = await Promise.all([
    activeThermalQuarantineEvent(tx, machineId),
    tx.machine.findUnique({
      where: { id: machineId },
      select: { moderationStatus: true, quarantineReasonCode: true },
    }),
  ]);
  if (!activeThermal || machine?.moderationStatus !== ModerationStatus.QUARANTINED) return null;

  const running = await tx.diagnosticRun.findFirst({
    where: { machineId, status: 'RUNNING' },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  });
  if (running) return running.id;

  const run = await tx.diagnosticRun.create({
    data: {
      machineId,
      status: 'RUNNING',
      triggeredBy: 'SYSTEM',
      startedAt: now,
    },
    select: { id: true },
  });
  await recordDiagnosticEvent(tx, {
    machineId,
    diagnosticRunId: run.id,
    reasonCode: machine.quarantineReasonCode ?? QuarantineReasonCode.GPU_HEALTH_CHECK_FAILED,
    reason: `GPU refroidi à ${observation.temperatureC} °C : diagnostic automatique lancé pour lever la quarantaine sans intervention manuelle.`,
    details: {
      subreasonCode: GPU_THERMAL_SUBREASON,
      hardwareUuid: observation.hardwareUuid,
      temperatureC: observation.temperatureC,
      recoveryThresholdC: GPU_THERMAL_RECOVERY_CELSIUS,
    },
    source: 'accelerator-heartbeat.thermal-recovery',
    now,
  });
  return run.id;
}

/**
 * Enforce only the thermal part of quarantine policy.
 *
 * - <98 C never ENTERS a thermal quarantine.
 * - >=98 C enters it once, with durable measured evidence.
 * - an existing unrelated quarantine is never overwritten by temperature.
 * - once an existing thermal quarantine cools to <=90 C, a real DiagnosticRun
 *   is queued automatically; the diagnostic, not the heartbeat, owns clearing.
 */
export async function enforceGpuThermalQuarantine(
  tx: Prisma.TransactionClient,
  machineId: string,
  accelerators: readonly AcceleratorTelemetry[],
  now = new Date(),
): Promise<GpuThermalEnforcement> {
  const observation = hottestGpuTemperature(accelerators);
  const existingThermal = await activeThermalQuarantineEvent(tx, machineId);

  if (!observation) {
    return {
      observation: null,
      blocking: Boolean(existingThermal),
      quarantineEntered: false,
      recoveryDiagnosticRunId: null,
    };
  }

  if (observation.temperatureC < GPU_THERMAL_QUARANTINE_CELSIUS) {
    const recoveryDiagnosticRunId = existingThermal
      ? await queueAutomaticThermalRecoveryDiagnostic(tx, machineId, observation, now)
      : null;
    return {
      observation,
      blocking: Boolean(existingThermal),
      quarantineEntered: false,
      recoveryDiagnosticRunId,
    };
  }

  const machine = await tx.machine.findUnique({
    where: { id: machineId },
    select: { moderationStatus: true },
  });
  if (!machine) {
    return {
      observation,
      blocking: true,
      quarantineEntered: false,
      recoveryDiagnosticRunId: null,
    };
  }

  // Never replace a security/cleanup/fencing cause that already owns the
  // quarantine. The high temperature still keeps the machine non-publishable,
  // but the primary recorded cause remains truthful.
  if (machine.moderationStatus !== ModerationStatus.CLEAR) {
    return {
      observation,
      blocking: true,
      quarantineEntered: false,
      recoveryDiagnosticRunId: null,
    };
  }

  await tx.machine.update({
    where: { id: machineId },
    data: { operational: MachineOperational.UNAVAILABLE },
  });
  await enterQuarantine(tx, {
    machineId,
    reasonCode: QuarantineReasonCode.GPU_HEALTH_CHECK_FAILED,
    reason: `Limite thermique GPU atteinte : ${observation.temperatureC} °C (quarantaine à partir de ${GPU_THERMAL_QUARANTINE_CELSIUS} °C).`,
    details: {
      subreasonCode: GPU_THERMAL_SUBREASON,
      hardwareUuid: observation.hardwareUuid,
      temperatureC: observation.temperatureC,
      quarantineThresholdC: GPU_THERMAL_QUARANTINE_CELSIUS,
      recoveryThresholdC: GPU_THERMAL_RECOVERY_CELSIUS,
    },
    source: 'accelerator-heartbeat.thermal',
    now,
  });

  return {
    observation,
    blocking: true,
    quarantineEntered: true,
    recoveryDiagnosticRunId: null,
  };
}
