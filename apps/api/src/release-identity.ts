const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i;

const RELEASE_ENV_KEYS = [
  'GPUBNB_RELEASE_SHA',
  'RENDER_GIT_COMMIT',
  'GITHUB_SHA',
] as const;

export type ReleaseIdentity = {
  commit: string | null;
  source: typeof RELEASE_ENV_KEYS[number] | null;
};

/**
 * Resolve the immutable source commit for the running API without exposing any
 * provider credential or deployment token. Production Render services provide
 * RENDER_GIT_COMMIT automatically; GPUBNB_RELEASE_SHA exists as an explicit,
 * provider-neutral override for other runtimes and GITHUB_SHA supports CI.
 */
export function resolveReleaseIdentity(env: NodeJS.ProcessEnv = process.env): ReleaseIdentity {
  for (const key of RELEASE_ENV_KEYS) {
    const raw = String(env[key] ?? '').trim();
    if (FULL_COMMIT_RE.test(raw)) {
      return { commit: raw.toLowerCase(), source: key };
    }
  }
  return { commit: null, source: null };
}
