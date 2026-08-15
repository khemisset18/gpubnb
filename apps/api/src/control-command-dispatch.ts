import type { Redis } from 'ioredis';

import { controlChannelBucket } from './agent-control-channel.js';
import type { ClaimedMachineCommand } from './delivery-store.js';

const MAX_CONTROL_PAYLOAD_BYTES = 48 * 1024;
const DISPATCH_TIMEOUT_MS = 2_000;
const TERMINAL_ACKS = new Set(['SUCCEEDED', 'FAILED', 'REJECTED']);
const STOP_REASONS = new Set(['renter', 'owner', 'platform']);

export type GatewayCommandKind = 'STOP_RENTAL' | 'START_MINING' | 'STOP_MINING';

export type CommandDispatchConfig = {
  adminUrl?: string | undefined;
  internalToken?: string | undefined;
  rolloutBps: number;
  agentControlRolloutBps: number;
};

export type TerminalGatewayAck = {
  status: 'SUCCEEDED' | 'FAILED' | 'REJECTED';
  detailCode?: string;
};

function parseRolloutBps(value: string | undefined, error: string): number {
  const raw = value ?? '0';
  if (!/^\d{1,5}$/.test(raw)) throw new Error(error);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) throw new Error(error);
  return parsed;
}

export function commandDispatchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CommandDispatchConfig {
  const rolloutBps = parseRolloutBps(env.MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS, 'machine_command_rollout_bps_invalid');
  const agentControlRolloutBps = parseRolloutBps(env.AGENT_CONTROL_CHANNEL_ROLLOUT_BPS, 'agent_control_rollout_bps_invalid');
  if (rolloutBps > agentControlRolloutBps) {
    throw new Error('machine_command_rollout_exceeds_agent_control_rollout');
  }
  const adminUrl = env.CONTROL_GATEWAY_ADMIN_URL?.trim() || undefined;
  const internalToken = env.CONTROL_GATEWAY_INTERNAL_TOKEN?.trim() || undefined;
  if (rolloutBps > 0) {
    if (!adminUrl || !internalToken || internalToken.length < 32) {
      throw new Error('machine_command_gateway_config_required_for_rollout');
    }
    let parsed: URL;
    try {
      parsed = new URL(adminUrl);
    } catch {
      throw new Error('control_gateway_admin_url_invalid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('control_gateway_admin_url_invalid');
    }
  }
  return { adminUrl, internalToken, rolloutBps, agentControlRolloutBps };
}

export function commandGatewayAssigned(machineId: string, config: CommandDispatchConfig): boolean {
  const bucket = controlChannelBucket(machineId);
  return Boolean(config.adminUrl && config.internalToken)
    && config.rolloutBps > 0
    && bucket < config.rolloutBps
    && bucket < config.agentControlRolloutBps;
}

export function commandKindForDurableType(commandType: string): GatewayCommandKind | undefined {
  switch (commandType) {
    case 'stop_rental': return 'STOP_RENTAL';
    case 'start_mining': return 'START_MINING';
    case 'stop_mining': return 'STOP_MINING';
    default: return undefined;
  }
}

function gatewayPayload(kind: GatewayCommandKind, durablePayload: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'STOP_RENTAL') return durablePayload;
  const sessionId = durablePayload.sessionId;
  const workspaceSlug = durablePayload.workspaceSlug;
  const reason = durablePayload.reason;
  if (typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 160) {
    throw new Error('stop_rental_session_id_missing');
  }
  if (workspaceSlug !== 'developer') {
    throw new Error('stop_rental_workspace_not_direct');
  }
  if (reason !== undefined && (typeof reason !== 'string' || !STOP_REASONS.has(reason))) {
    throw new Error('stop_rental_reason_invalid');
  }
  return {
    sessionId,
    workspaceSlug,
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

export function controlEnvelope(command: ClaimedMachineCommand): Record<string, unknown> {
  const kind = commandKindForDurableType(command.commandType);
  if (!kind) throw new Error('machine_command_not_fast_path_eligible');
  if (command.sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('machine_command_sequence_not_json_safe');
  }
  const payload = gatewayPayload(kind, command.payload);
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (payloadBytes > MAX_CONTROL_PAYLOAD_BYTES) throw new Error('machine_command_payload_too_large_for_gateway');
  const issuedAtMs = command.createdAt.getTime();
  const expiresAtMs = command.expiresAt.getTime();
  if (!Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= issuedAtMs) {
    throw new Error('machine_command_time_invalid');
  }
  return {
    protocolVersion: 1,
    commandId: command.id,
    machineId: command.machineId,
    sequence: Number(command.sequence),
    kind,
    issuedAtMs,
    expiresAtMs,
    payload,
  };
}

export function commandAckKey(machineId: string, commandId: string): string {
  return `gpubnb:command-ack:{${machineId}}:${commandId}:v1`;
}

export async function readTerminalGatewayAck(
  redis: Redis,
  command: Pick<ClaimedMachineCommand, 'id' | 'machineId' | 'sequence'>,
): Promise<TerminalGatewayAck | undefined> {
  const key = commandAckKey(command.machineId, command.id);
  const [ttlMs, fields] = await Promise.all([redis.pttl(key), redis.hgetall(key)]);
  if (ttlMs <= 0 || Object.keys(fields).length === 0) return undefined;
  if (fields.machineId !== command.machineId || fields.sequence !== command.sequence.toString()) {
    throw new Error('gateway_command_ack_identity_conflict');
  }
  const status = fields.status;
  if (!status || !TERMINAL_ACKS.has(status)) return undefined;
  const detailCode = fields.detailCode?.trim() || undefined;
  return {
    status: status as TerminalGatewayAck['status'],
    ...(detailCode ? { detailCode } : {}),
  };
}

export async function dispatchToGateway(
  command: ClaimedMachineCommand,
  config: CommandDispatchConfig,
): Promise<'DELIVERED' | 'QUEUED_DISCONNECTED' | 'QUEUED_BACKPRESSURE' | 'EXISTING'> {
  // Mining kinds are intentionally dark-qualified only in this layer. Even if a
  // future SQL change accidentally claims one, production dispatch refuses it.
  if (command.commandType !== 'stop_rental' || command.payload.workspaceSlug !== 'developer') {
    throw new Error('machine_command_not_production_fast_path');
  }
  if (!config.adminUrl || !config.internalToken) throw new Error('control_gateway_admin_not_configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const url = new URL(`/v1/internal/commands/${encodeURIComponent(command.machineId)}`, config.adminUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gpubnb-internal-token': config.internalToken,
      },
      body: JSON.stringify(controlEnvelope(command)),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as { accepted?: unknown; status?: unknown; error?: unknown };
    if (response.status !== 202 || body.accepted !== true || typeof body.status !== 'string') {
      throw new Error(`control_gateway_dispatch_rejected:${response.status}:${String(body.error ?? body.status ?? 'unknown')}`);
    }
    if (!['DELIVERED', 'QUEUED_DISCONNECTED', 'QUEUED_BACKPRESSURE', 'EXISTING'].includes(body.status)) {
      throw new Error('control_gateway_dispatch_status_invalid');
    }
    return body.status as 'DELIVERED' | 'QUEUED_DISCONNECTED' | 'QUEUED_BACKPRESSURE' | 'EXISTING';
  } finally {
    clearTimeout(timer);
  }
}
