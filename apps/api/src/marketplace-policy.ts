export type TimeRange = {
  startsAt: Date;
  endsAt: Date;
};

export type PriceOffer = {
  proposerId: string;
  hourlyLamports: bigint;
  startsAt: Date;
  endsAt: Date;
};

export type PriceAgreement = PriceOffer & {
  acceptedById: string;
  acceptedAt: Date;
};

const assertValidDate = (value: Date, field: string): void => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${field} must be a valid date`);
  }
};

/**
 * GPUbnb intentionally has no product-level maximum rental duration.
 * Database and escrow limits may still be checked separately for numeric safety.
 */
export function validateRentalWindow(range: TimeRange): number {
  assertValidDate(range.startsAt, 'startsAt');
  assertValidDate(range.endsAt, 'endsAt');
  const milliseconds = range.endsAt.getTime() - range.startsAt.getTime();
  if (milliseconds <= 0) throw new RangeError('endsAt must be after startsAt');
  const seconds = Math.ceil(milliseconds / 1000);
  if (!Number.isSafeInteger(seconds)) throw new RangeError('rental duration exceeds safe integer range');
  return seconds;
}

export function rangesOverlap(left: TimeRange, right: TimeRange): boolean {
  validateRentalWindow(left);
  validateRentalWindow(right);
  return left.startsAt < right.endsAt && right.startsAt < left.endsAt;
}

/**
 * Returns the exclusive end of an instant rental. A future funded reservation
 * always wins, so an instant renter may use the machine only until it begins.
 */
export function instantRentalDeadline(
  now: Date,
  futureReservations: TimeRange[],
): Date | null {
  assertValidDate(now, 'now');
  const candidates = futureReservations
    .map(range => {
      validateRentalWindow(range);
      return range;
    })
    .filter(range => range.startsAt > now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return candidates[0]?.startsAt ?? null;
}

export function assertInstantRentalFits(
  now: Date,
  requestedEndsAt: Date,
  futureReservations: TimeRange[],
): void {
  validateRentalWindow({ startsAt: now, endsAt: requestedEndsAt });
  const deadline = instantRentalDeadline(now, futureReservations);
  if (deadline && requestedEndsAt > deadline) {
    throw new RangeError('instant rental overlaps the next reservation');
  }
}

export function createPriceAgreement(
  offer: PriceOffer,
  acceptedById: string,
  acceptedAt: Date,
): PriceAgreement {
  if (!offer.proposerId.trim()) throw new RangeError('proposerId is required');
  if (!acceptedById.trim()) throw new RangeError('acceptedById is required');
  if (acceptedById === offer.proposerId) throw new RangeError('an offer requires the other party acceptance');
  if (offer.hourlyLamports <= 0n) throw new RangeError('hourlyLamports must be positive');
  validateRentalWindow(offer);
  assertValidDate(acceptedAt, 'acceptedAt');
  return { ...offer, acceptedById, acceptedAt };
}

/**
 * Scheduled time is reserved from startsAt even when the provider is late.
 * Provider compensation remains independently capped by signed verified uptime.
 */
export function scheduledReservationSeconds(
  startsAt: Date,
  endsAt: Date,
  observedAt: Date,
): number {
  validateRentalWindow({ startsAt, endsAt });
  assertValidDate(observedAt, 'observedAt');
  const cappedEnd = Math.min(observedAt.getTime(), endsAt.getTime());
  if (cappedEnd <= startsAt.getTime()) return 0;
  return Math.floor((cappedEnd - startsAt.getTime()) / 1000);
}

export function providerPayableSeconds(
  scheduledSeconds: number,
  verifiedUptimeSeconds: number,
): number {
  if (!Number.isSafeInteger(scheduledSeconds) || scheduledSeconds < 0) {
    throw new RangeError('scheduledSeconds must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(verifiedUptimeSeconds) || verifiedUptimeSeconds < 0) {
    throw new RangeError('verifiedUptimeSeconds must be a non-negative safe integer');
  }
  return Math.min(scheduledSeconds, verifiedUptimeSeconds);
}

/**
 * Hardware names are opaque vendor-provided identifiers. Never reject a GPU
 * merely because its model or accelerator architecture is unknown to GPUbnb.
 */
export function normalizeAcceleratorIdentity(input: {
  vendor?: string | null;
  model: string;
  stableId?: string | null;
}): { vendor: string; model: string; stableId: string | null } {
  const model = input.model.trim();
  if (!model) throw new RangeError('accelerator model is required');
  if (model.length > 300) throw new RangeError('accelerator model is too long');
  const vendor = input.vendor?.trim() || 'unknown';
  if (vendor.length > 80) throw new RangeError('accelerator vendor is too long');
  const stableId = input.stableId?.trim() || null;
  if (stableId && stableId.length > 300) throw new RangeError('accelerator stableId is too long');
  return { vendor, model, stableId };
}
