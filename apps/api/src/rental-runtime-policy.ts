export const DEFAULT_RENTAL_HEARTBEAT_OFFLINE_SECONDS = 60;

export function rentalHeartbeatOfflineSeconds(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment.HEARTBEAT_OFFLINE_SECONDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RENTAL_HEARTBEAT_OFFLINE_SECONDS;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 15 || value > 300) {
    throw new Error('invalid_rental_heartbeat_offline_seconds');
  }
  return value;
}
