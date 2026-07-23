export function validatedUsageIncrement(
  currentValidSeconds: number,
  expectedSeconds: number,
  intervalSeconds: number,
  available: boolean,
  workloadProof: boolean,
): number {
  if (!available || !workloadProof) return 0;
  const remaining = Math.max(0, expectedSeconds - currentValidSeconds);
  return Math.min(intervalSeconds, remaining);
}
