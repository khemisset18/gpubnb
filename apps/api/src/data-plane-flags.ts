export interface DataPlaneRolloutFlags {
  edgeQuicEnabled: boolean;
  directQuicEnabled: boolean;
  browserWebTransportEnabled: boolean;
  legacyFallbackEnabled: boolean;
  canaryPercent: number;
  qualifiedReleaseSha: string | null;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const COMMIT_SHA = /^[a-f0-9]{40}$/i;

function strictBoolean(raw: string | undefined, name: string, defaultValue = false): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new Error(`${name}_invalid_boolean`);
}

function strictPercent(raw: string | undefined, name: string): number {
  if (raw === undefined || raw.trim() === '') return 0;
  if (!/^\d{1,3}$/.test(raw.trim())) throw new Error(`${name}_invalid_percent`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${name}_invalid_percent`);
  return value;
}

function strictCommitSha(raw: string | undefined, name: string): string {
  const value = raw?.trim() ?? '';
  if (!COMMIT_SHA.test(value)) throw new Error(`${name}_invalid_sha`);
  return value.toLowerCase();
}

function resolveReleaseSha(env: Readonly<Record<string, string | undefined>>): string {
  const onRender = strictBoolean(env.RENDER, 'RENDER', false);
  if (!onRender) return strictCommitSha(env.GPUBNB_RELEASE_SHA, 'GPUBNB_RELEASE_SHA');

  const renderSha = strictCommitSha(env.RENDER_GIT_COMMIT, 'RENDER_GIT_COMMIT');
  const declared = env.GPUBNB_RELEASE_SHA?.trim();
  if (declared) {
    const declaredSha = strictCommitSha(declared, 'GPUBNB_RELEASE_SHA');
    if (declaredSha !== renderSha) throw new Error('data_plane_release_sha_mismatch');
  }
  return renderSha;
}

export function assertDataPlaneReleaseQualified(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const releaseSha = resolveReleaseSha(env);
  const qualifiedSha = strictCommitSha(
    env.GPUBNB_DATA_PLANE_QUALIFIED_SHA,
    'GPUBNB_DATA_PLANE_QUALIFIED_SHA',
  );
  if (releaseSha !== qualifiedSha) throw new Error('data_plane_release_not_qualified');
  return qualifiedSha;
}

export function readDataPlaneRolloutFlags(
  env: Readonly<Record<string, string | undefined>>,
): DataPlaneRolloutFlags {
  const edgeQuicEnabled = strictBoolean(env.GPUBNB_DATA_PLANE_EDGE_QUIC, 'GPUBNB_DATA_PLANE_EDGE_QUIC');
  const directQuicEnabled = strictBoolean(env.GPUBNB_DATA_PLANE_DIRECT_QUIC, 'GPUBNB_DATA_PLANE_DIRECT_QUIC');
  const browserWebTransportEnabled = strictBoolean(
    env.GPUBNB_DATA_PLANE_BROWSER_WEBTRANSPORT,
    'GPUBNB_DATA_PLANE_BROWSER_WEBTRANSPORT',
  );
  // During migration the old path is deliberately available by default. Retirement is a separate ADR.
  const legacyFallbackEnabled = strictBoolean(
    env.GPUBNB_DATA_PLANE_LEGACY_FALLBACK,
    'GPUBNB_DATA_PLANE_LEGACY_FALLBACK',
    true,
  );
  const canaryPercent = strictPercent(env.GPUBNB_DATA_PLANE_CANARY_PERCENT, 'GPUBNB_DATA_PLANE_CANARY_PERCENT');

  if (canaryPercent > 0 && !edgeQuicEnabled && !directQuicEnabled) {
    throw new Error('data_plane_canary_without_transport');
  }
  if (browserWebTransportEnabled && !directQuicEnabled) {
    throw new Error('browser_webtransport_requires_direct_quic');
  }

  const newTransportRequested =
    edgeQuicEnabled || directQuicEnabled || browserWebTransportEnabled || canaryPercent > 0;
  const qualifiedReleaseSha = newTransportRequested ? assertDataPlaneReleaseQualified(env) : null;

  return {
    edgeQuicEnabled,
    directQuicEnabled,
    browserWebTransportEnabled,
    legacyFallbackEnabled,
    canaryPercent,
    qualifiedReleaseSha,
  };
}

// Deterministic rollout keeps a session on one transport across retries and deploys.
export function isDataPlaneCanary(sessionId: string, canaryPercent: number): boolean {
  if (!Number.isInteger(canaryPercent) || canaryPercent < 0 || canaryPercent > 100) {
    throw new Error('data_plane_canary_percent_invalid');
  }
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new Error('data_plane_canary_session_id_invalid');
  if (canaryPercent === 0) return false;
  if (canaryPercent === 100) return true;

  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % 100 < canaryPercent;
}
