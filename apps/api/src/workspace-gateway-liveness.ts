export const WORKSPACE_GATEWAY_LIVENESS_MAX_AGE_SECONDS = 45;

export function isWorkspaceGatewayLive(
  lastSeenAt: Date | null | undefined,
  now: Date = new Date(),
  maxAgeSeconds: number = WORKSPACE_GATEWAY_LIVENESS_MAX_AGE_SECONDS,
): boolean {
  if (!(lastSeenAt instanceof Date) || Number.isNaN(lastSeenAt.getTime())) return false;
  const ageMs = now.getTime() - lastSeenAt.getTime();
  return ageMs >= 0 && ageMs <= maxAgeSeconds * 1000;
}
