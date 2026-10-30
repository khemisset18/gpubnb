import { config } from './config.js';

/**
 * Console capture is a *private qualification* backend, never a substitute for
 * the legacy IddCx capability or an automatic public-booking fallback.
 * Exact Agent source pin is mandatory; an absent/invalid pin disables selection.
 */
const SHA40 = /^[a-f0-9]{40}$/i;
export const CONSOLE_BACKEND = 'console-dedicated';

export function privateConsoleAgentCommit(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const commit = env.GPUBNB_PRIVATE_CONSOLE_AGENT_COMMIT ?? '';
  if (
    env.GPUBNB_PRIVATE_CONSOLE_QUALIFICATION !== 'true'
    || config.BETA_TEST_DEV_BYPASS !== 'true'
    || config.ESCROW_PROGRAM_ID !== 'NOT_DEPLOYED_YET'
    || !SHA40.test(commit)
  ) return null;
  return commit.toLowerCase();
}

/** Bound into immutable, server-created session resource limits. */
export function privateConsoleSessionMarker(commit: string | null): {
  captureBackend: 'console-dedicated';
  agentCommit: string;
} | undefined {
  return commit === null ? undefined : {
    captureBackend: CONSOLE_BACKEND,
    agentCommit: commit,
  };
}

/** Reject tampered/stale session markers rather than falling back to IddCx. */
export function privateConsoleDesiredFields(
  resourceLimits: unknown,
  approvedCommit: string | null,
): Record<string, unknown> {
  if (!resourceLimits || typeof resourceLimits !== 'object' || Array.isArray(resourceLimits)) {
    return {};
  }
  const marker = (resourceLimits as Record<string, unknown>).privateConsoleQualification;
  if (marker === undefined) return {};
  if (
    !marker || typeof marker !== 'object' || Array.isArray(marker)
    || (marker as Record<string, unknown>).captureBackend !== CONSOLE_BACKEND
    || typeof (marker as Record<string, unknown>).agentCommit !== 'string'
    || approvedCommit === null
    || (marker as Record<string, unknown>).agentCommit !== approvedCommit
  ) {
    return { captureBackend: 'console-authorization-invalid' };
  }
  return { captureBackend: CONSOLE_BACKEND, consoleAgentCommit: approvedCommit };
}
