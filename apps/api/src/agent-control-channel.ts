import crypto from 'node:crypto';

export const AGENT_CONTROL_PROTOCOL_VERSION = 1;

export type AgentControlChannelConfig = {
  CONTROL_GATEWAY_PUBLIC_HOST?: string | undefined;
  CONTROL_GATEWAY_PUBLIC_PORT: number;
  CONTROL_GATEWAY_TLS_SERVER_NAME?: string | undefined;
  AGENT_CONTROL_CHANNEL_ROLLOUT_BPS: number;
  AGENT_CONTROL_FALLBACK_POLL_SECONDS: number;
};

export type AgentControlChannelAssignment = {
  enabled: boolean;
  protocolVersion: 1;
  fallbackPollSeconds: number;
  host?: string;
  port?: number;
  serverName?: string;
};

export const controlChannelBucket = (machineId: string): number => {
  const digest = crypto.createHash('sha256').update(`gpubnb-agent-control-v1\0${machineId}`).digest();
  return digest.readUInt32BE(0) % 10_000;
};

export const controlChannelAssignment = (
  machineId: string,
  config: AgentControlChannelConfig,
): AgentControlChannelAssignment => {
  const base = {
    protocolVersion: 1 as const,
    fallbackPollSeconds: config.AGENT_CONTROL_FALLBACK_POLL_SECONDS,
  };
  const host = config.CONTROL_GATEWAY_PUBLIC_HOST;
  const enabled = Boolean(host)
    && config.AGENT_CONTROL_CHANNEL_ROLLOUT_BPS > 0
    && controlChannelBucket(machineId) < config.AGENT_CONTROL_CHANNEL_ROLLOUT_BPS;
  if (!enabled || !host) return { enabled: false, ...base };
  return {
    enabled: true,
    ...base,
    host,
    port: config.CONTROL_GATEWAY_PUBLIC_PORT,
    serverName: config.CONTROL_GATEWAY_TLS_SERVER_NAME ?? host,
  };
};
