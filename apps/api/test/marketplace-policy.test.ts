import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertInstantRentalFits,
  createPriceAgreement,
  instantRentalDeadline,
  normalizeAcceleratorIdentity,
  providerPayableSeconds,
  rangesOverlap,
  scheduledReservationSeconds,
  validateRentalWindow,
} from '../src/marketplace-policy.js';

const date = (value: string): Date => new Date(value);

test('accepts multi-month reservations without a product duration limit', () => {
  const seconds = validateRentalWindow({
    startsAt: date('2026-08-01T00:00:00Z'),
    endsAt: date('2027-02-01T00:00:00Z'),
  });
  assert.equal(seconds, 15_897_600);
});

test('treats adjacent reservations as non-overlapping', () => {
  assert.equal(rangesOverlap(
    { startsAt: date('2026-08-01T12:00:00Z'), endsAt: date('2026-08-01T14:00:00Z') },
    { startsAt: date('2026-08-01T14:00:00Z'), endsAt: date('2026-08-01T16:00:00Z') },
  ), false);
});

test('instant rental ends no later than the next future reservation', () => {
  const now = date('2026-08-01T10:00:00Z');
  const deadline = instantRentalDeadline(now, [
    { startsAt: date('2026-08-01T18:00:00Z'), endsAt: date('2026-08-01T20:00:00Z') },
    { startsAt: date('2026-08-01T14:00:00Z'), endsAt: date('2026-08-01T16:00:00Z') },
  ]);
  assert.equal(deadline?.toISOString(), '2026-08-01T14:00:00.000Z');
  assert.doesNotThrow(() => assertInstantRentalFits(now, date('2026-08-01T14:00:00Z'), [
    { startsAt: date('2026-08-01T14:00:00Z'), endsAt: date('2026-08-01T16:00:00Z') },
  ]));
  assert.throws(() => assertInstantRentalFits(now, date('2026-08-01T14:00:01Z'), [
    { startsAt: date('2026-08-01T14:00:00Z'), endsAt: date('2026-08-01T16:00:00Z') },
  ]), /overlaps/);
});

test('requires bilateral acceptance of a negotiated price', () => {
  const agreement = createPriceAgreement({
    proposerId: 'renter-1',
    hourlyLamports: 900_000n,
    startsAt: date('2026-08-01T14:00:00Z'),
    endsAt: date('2026-08-01T16:00:00Z'),
  }, 'owner-1', date('2026-07-30T12:00:00Z'));
  assert.equal(agreement.hourlyLamports, 900_000n);
  assert.equal(agreement.acceptedById, 'owner-1');
  assert.throws(() => createPriceAgreement(agreement, 'renter-1', new Date()), /other party/);
});

test('scheduled reservation time starts at the agreed hour even if provider is late', () => {
  const scheduled = scheduledReservationSeconds(
    date('2026-08-01T14:00:00Z'),
    date('2026-08-01T16:00:00Z'),
    date('2026-08-01T14:18:00Z'),
  );
  assert.equal(scheduled, 1_080);
  assert.equal(providerPayableSeconds(scheduled, 0), 0);
  assert.equal(providerPayableSeconds(7_200, 6_120), 6_120);
});

test('accepts unknown and future accelerator identities', () => {
  assert.deepEqual(normalizeAcceleratorIdentity({
    vendor: 'Future Quantum Devices',
    model: 'QPU-GPU Hybrid 9000',
    stableId: 'fq-9000-alpha',
  }), {
    vendor: 'Future Quantum Devices',
    model: 'QPU-GPU Hybrid 9000',
    stableId: 'fq-9000-alpha',
  });
  assert.equal(normalizeAcceleratorIdentity({ model: 'Unknown PCI Accelerator' }).vendor, 'unknown');
});
