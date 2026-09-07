export const MAX_RUNTIME_EXPECTED_SESSIONS = 64;

export function canonicalRuntimeSessionIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((value) => typeof value === 'string' && value.length > 0))].sort();
}

/**
 * The Host classifies Docker resources against the session-authority snapshot
 * supplied with the diagnostic assignment.  A result is only safe to use if
 * that exact authority snapshot is still current when the API receives it.
 * Otherwise a session could terminate between assignment and result and leave
 * a leaked container that was "expected" only by the stale snapshot.
 */
export function runtimeExpectationMatches(
  reportedSessionIds: readonly string[],
  currentSessionIds: readonly string[],
): boolean {
  const reported = canonicalRuntimeSessionIds(reportedSessionIds);
  const current = canonicalRuntimeSessionIds(currentSessionIds);
  if (reported.length !== current.length) return false;
  return reported.every((value, index) => value === current[index]);
}
