export type SupportCheck = {
  id: string;
  ok: boolean;
  blocking?: boolean;
  actionLabel?: string | null;
};

export type SupportGpu = {
  uuid?: string | null;
  model: string;
  driverVersion?: string | null;
  vramMib?: number | null;
};

export type SupportStatusInput = {
  platform: string;
  architecture: string;
  ready: boolean;
  lifecycle: string;
  progress: number;
  blockingCount: number;
  summary: string;
  agent: {
    installed: boolean;
    linked: boolean;
    running: boolean;
    serviceInstalled?: boolean;
    serviceRunning?: boolean;
    machineId?: string | null;
  };
  pairing?: {
    configured?: boolean;
    storesPassword?: boolean;
  };
  diagnostic: {
    canHost: boolean;
    reason: string;
    gpus?: SupportGpu[];
  };
  checks: SupportCheck[];
};

export type PrivacySafeSupportReport = {
  schemaVersion: 1;
  generatedAt: string;
  host: {
    platform: string;
    architecture: string;
    ready: boolean;
    lifecycle: string;
    progress: number;
    blockingCount: number;
    summary: string;
  };
  agent: {
    installed: boolean;
    linked: boolean;
    running: boolean;
    serviceInstalled: boolean;
    serviceRunning: boolean;
    machineRef: string | null;
  };
  pairing: {
    configured: boolean;
    storesPassword: boolean;
  };
  diagnostic: {
    canHost: boolean;
    reason: string;
    gpus: Array<{
      gpuRef: string | null;
      model: string;
      driverVersion: string | null;
      vramMib: number | null;
    }>;
  };
  checks: Array<{
    id: string;
    ok: boolean;
    blocking: boolean;
    actionRequired: boolean;
  }>;
};

const identifierRef = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  const suffix = normalized.slice(-8);
  return `…${suffix}`;
};

const boundedText = (value: string, max = 160): string => String(value ?? '').slice(0, max);

/**
 * Build a support payload from already-collected Host status only.
 *
 * Deliberately omitted: pairing/browser URLs, account identity, wallet/pool
 * configuration, filesystem paths, logs, environment variables, cookies,
 * tokens, private/public signing keys and full machine/GPU identifiers.
 */
export const buildPrivacySafeSupportReport = (
  status: SupportStatusInput,
  generatedAt = new Date().toISOString(),
): PrivacySafeSupportReport => ({
  schemaVersion: 1,
  generatedAt,
  host: {
    platform: boundedText(status.platform, 40),
    architecture: boundedText(status.architecture, 40),
    ready: Boolean(status.ready),
    lifecycle: boundedText(status.lifecycle, 40),
    progress: Math.max(0, Math.min(100, Math.trunc(status.progress))),
    blockingCount: Math.max(0, Math.trunc(status.blockingCount)),
    summary: boundedText(status.summary, 160),
  },
  agent: {
    installed: Boolean(status.agent.installed),
    linked: Boolean(status.agent.linked),
    running: Boolean(status.agent.running),
    serviceInstalled: Boolean(status.agent.serviceInstalled),
    serviceRunning: Boolean(status.agent.serviceRunning),
    machineRef: identifierRef(status.agent.machineId),
  },
  pairing: {
    configured: Boolean(status.pairing?.configured),
    storesPassword: Boolean(status.pairing?.storesPassword),
  },
  diagnostic: {
    canHost: Boolean(status.diagnostic.canHost),
    reason: boundedText(status.diagnostic.reason, 120),
    gpus: (status.diagnostic.gpus ?? []).slice(0, 16).map((gpu) => ({
      gpuRef: identifierRef(gpu.uuid),
      model: boundedText(gpu.model, 120),
      driverVersion: gpu.driverVersion ? boundedText(gpu.driverVersion, 80) : null,
      vramMib: Number.isFinite(gpu.vramMib) ? Math.max(0, Math.trunc(gpu.vramMib as number)) : null,
    })),
  },
  checks: status.checks.slice(0, 32).map((check) => ({
    id: boundedText(check.id, 64),
    ok: Boolean(check.ok),
    blocking: Boolean(check.blocking),
    actionRequired: !check.ok && Boolean(check.actionLabel),
  })),
});

export const serializePrivacySafeSupportReport = (status: SupportStatusInput): string =>
  JSON.stringify(buildPrivacySafeSupportReport(status), null, 2);
