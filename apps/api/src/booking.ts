const REFUND_GRACE_SECONDS = 3_600;

/** Keep escrow funded until the reservation ends, plus a settlement grace period. */
export function escrowExpiryUnix(endsAt: Date): bigint {
  const milliseconds = endsAt.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('invalid booking end');
  return BigInt(Math.floor(milliseconds / 1_000) + REFUND_GRACE_SECONDS);
}
