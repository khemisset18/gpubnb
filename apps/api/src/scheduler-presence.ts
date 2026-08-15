import type { Redis } from 'ioredis';

import { controlChannelBucket } from './agent-control-channel.js';
import { readMachinePresence, type MachinePresenceSnapshot } from './machine-presence.js';

export type SchedulerPresenceMode = 'legacy' | 'shadow' | 'hot';

export type SchedulerPresenceDecision = {
  mode: SchedulerPresenceMode;
  assigned: boolean;
  live: boolean;
  phase?: MachinePresenceSnapshot['phase'];
  gatewayId?: string;
  reason?: string;
};

export class SchedulerPresenceError extends Error {
  constructor(public readonly code: 'machine_hot_presence_offline' | 'machine_hot_presence_quarantined' | 'machine_hot_presence_unavailable') {
    super(code);
    this.name = 'SchedulerPresenceError';
  }
}

type Runtime = {
  redis: Redis;
  mode: SchedulerPresenceMode;
  rolloutBps: number;
  agentControlRolloutBps: number;
};

let runtime: Runtime | undefined;

export function schedulerPresenceBucket(machineId: string): number {
  // Reuse the Agent Control Channel bucket so every hot-presence cohort is a
  // strict prefix of the machines that are already eligible to connect to QUIC.
  return controlChannelBucket(machineId);
}

function parseRolloutBps(value: string | undefined, error: string): number {
  const raw = value ?? '0';
  if (!/^\d{1,5}$/.test(raw)) throw new Error(error);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) throw new Error(error);
  return parsed;
}

export function schedulerPresenceRolloutBps(env: NodeJS.ProcessEnv = process.env): number {
  return parseRolloutBps(env.SCHEDULER_HOT_PRESENCE_ROLLOUT_BPS, 'scheduler_hot_presence_rollout_bps_invalid');
}

export function configureSchedulerPresence(
  redis: Redis,
  mode: SchedulerPresenceMode,
  parentOrEnv: number | NodeJS.ProcessEnv = process.env,
  explicitEnv: NodeJS.ProcessEnv = process.env,
): void {
  const env = typeof parentOrEnv === 'number' ? explicitEnv : parentOrEnv;
  const agentControlRolloutBps = typeof parentOrEnv === 'number'
    ? parentOrEnv
    : parseRolloutBps(env.AGENT_CONTROL_CHANNEL_ROLLOUT_BPS, 'agent_control_rollout_bps_invalid');
  if (!Number.isInteger(agentControlRolloutBps) || agentControlRolloutBps < 0 || agentControlRolloutBps > 10_000) {
    throw new Error('agent_control_rollout_bps_invalid');
  }
  const rolloutBps = schedulerPresenceRolloutBps(env);
  if (rolloutBps > agentControlRolloutBps) {
    throw new Error('scheduler_hot_presence_rollout_exceeds_agent_control_rollout');
  }
  runtime = { redis, mode, rolloutBps, agentControlRolloutBps };
}

export function resetSchedulerPresenceForTests(): void {
  runtime = undefined;
}

export async function schedulerPresenceDecision(machineId: string): Promise<SchedulerPresenceDecision> {
  const active = runtime;
  if (!active || active.mode === 'legacy') {
    return { mode: active?.mode ?? 'legacy', assigned: false, live: true };
  }
  const bucket = schedulerPresenceBucket(machineId);
  const assigned = active.mode === 'hot'
    && active.rolloutBps > 0
    && bucket < active.rolloutBps
    && bucket < active.agentControlRolloutBps;
  try {
    const snapshot = await readMachinePresence(active.redis, machineId);
    if (!snapshot) {
      return { mode: active.mode, assigned, live: false, reason: 'presence_missing_or_expired' };
    }
    return {
      mode: active.mode,
      assigned,
      live: true,
      phase: snapshot.phase,
      gatewayId: snapshot.gatewayId,
      ...(snapshot.phase === 'QUARANTINED' ? { reason: 'presence_quarantined' } : {}),
    };
  } catch (error) {
    if (active.mode === 'shadow' || !assigned) {
      return {
        mode: active.mode,
        assigned,
        live: false,
        reason: `presence_read_error:${error instanceof Error ? error.message : 'unknown'}`,
      };
    }
    throw new SchedulerPresenceError('machine_hot_presence_unavailable');
  }
}

export async function assertSchedulerMachinePresence(machineId: string): Promise<void> {
  const decision = await schedulerPresenceDecision(machineId);
  if (decision.mode === 'shadow') {
    console.info(JSON.stringify({
      level: 'info',
      message: 'scheduler_presence_shadow',
      machineId,
      live: decision.live,
      phase: decision.phase ?? null,
      gatewayId: decision.gatewayId ?? null,
      reason: decision.reason ?? null,
    }));
    return;
  }
  if (!decision.assigned) return;
  if (!decision.live) throw new SchedulerPresenceError('machine_hot_presence_offline');
  if (decision.phase === 'QUARANTINED') {
    throw new SchedulerPresenceError('machine_hot_presence_quarantined');
  }
}
