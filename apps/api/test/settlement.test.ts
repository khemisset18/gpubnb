import test from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_UNIT_SECONDS, bookingEscrowExpiryUnix, calculateSettlement } from '../src/settlement.js';

test('billing unit is one minute', () => {
  assert.equal(BILLING_UNIT_SECONDS, 60);
});

test('45 minutes of a 60-minute reservation makes 4.50 of 6 payable', () => {
  const settlement = calculateSettlement(600_000_000n, 45 * 60, 60 * 60, 0);

  assert.equal(settlement.payableLamports, 450_000_000n);
  assert.equal(settlement.providerLamports, 450_000_000n);
  assert.equal(settlement.platformLamports, 0n);
  assert.equal(settlement.refundLamports, 150_000_000n);
  assert.equal(settlement.availabilityBps, 7500);
});

test('40 minutes of a 60-minute reservation is billed as 40 minutes', () => {
  const settlement = calculateSettlement(60_000_000n, 2400, 3600);

  assert.equal(settlement.payableLamports, 40_000_000n);
  assert.equal(settlement.platformLamports, 2_000_000n);
  assert.equal(settlement.providerLamports, 38_000_000n);
  assert.equal(settlement.refundLamports, 20_000_000n);
});

test('an incomplete minute is not billed', () => {
  const settlement = calculateSettlement(60_000_000n, 45 * 60 + 59, 60 * 60, 0);

  assert.equal(settlement.payableLamports, 45_000_000n);
  assert.equal(settlement.providerLamports, 45_000_000n);
  assert.equal(settlement.refundLamports, 15_000_000n);
});

test('the next completed minute becomes billable', () => {
  const before = calculateSettlement(60_000_000n, 45 * 60 + 59, 60 * 60, 0);
  const after = calculateSettlement(60_000_000n, 46 * 60, 60 * 60, 0);

  assert.equal(before.payableLamports, 45_000_000n);
  assert.equal(after.payableLamports, 46_000_000n);
});

test('90 percent availability remains minute-proportional', () => {
  const settlement = calculateSettlement(100_000_000n, 54 * 60, 60 * 60);

  assert.equal(settlement.payableLamports, 90_000_000n);
  assert.equal(settlement.platformLamports, 4_500_000n);
  assert.equal(settlement.providerLamports, 85_500_000n);
  assert.equal(settlement.refundLamports, 10_000_000n);
});

test('full service pays the full escrow minus commission', () => {
  const settlement = calculateSettlement(100_000_000n, 3600, 3600);

  assert.equal(settlement.payableLamports, 100_000_000n);
  assert.equal(settlement.platformLamports, 5_000_000n);
  assert.equal(settlement.providerLamports, 95_000_000n);
  assert.equal(settlement.refundLamports, 0n);
});

test('a fully completed non-round reservation pays the full escrow', () => {
  const settlement = calculateSettlement(610_000n, 61, 61, 0);

  assert.equal(settlement.payableLamports, 610_000n);
  assert.equal(settlement.refundLamports, 0n);
});

test('zero validated service refunds the full amount', () => {
  const settlement = calculateSettlement(1_000_000n, 0, 1000);

  assert.equal(settlement.payableLamports, 0n);
  assert.equal(settlement.platformLamports, 0n);
  assert.equal(settlement.providerLamports, 0n);
  assert.equal(settlement.refundLamports, 1_000_000n);
});

test('settlement invariant holds for every second of an hour', () => {
  for (let validSeconds = 0; validSeconds <= 3600; validSeconds += 1) {
    const settlement = calculateSettlement(987_654_321n, validSeconds, 3600);

    assert.equal(
      settlement.providerLamports + settlement.platformLamports + settlement.refundLamports,
      settlement.grossLamports,
    );
    assert.equal(settlement.payableLamports, settlement.grossLamports - settlement.refundLamports);
  }
});

test('integer rounding never overcharges the renter', () => {
  const settlement = calculateSettlement(10n, 60, 180, 0);

  assert.equal(settlement.payableLamports, 3n);
  assert.equal(settlement.providerLamports, 3n);
  assert.equal(settlement.refundLamports, 7n);
});

test('rejects invalid durations and commissions', () => {
  assert.throws(() => calculateSettlement(100n, -1, 100));
  assert.throws(() => calculateSettlement(100n, 101, 100));
  assert.throws(() => calculateSettlement(100n, 0, 0));
  assert.throws(() => calculateSettlement(100n, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => calculateSettlement(100n, 50, 100, -1));
  assert.throws(() => calculateSettlement(100n, 50, 100, 10_001));
});

test('one lamport never creates money', () => {
  for (let validSeconds = 0; validSeconds <= 600; validSeconds += 1) {
    const settlement = calculateSettlement(1n, validSeconds, 600);
    assert.equal(
      settlement.providerLamports + settlement.platformLamports + settlement.refundLamports,
      1n,
    );
  }
});

test('escrow expires one hour after booking end', () => {
  const end = new Date('2026-07-22T12:00:00.000Z');
  assert.equal(bookingEscrowExpiryUnix(end), BigInt(Math.floor(end.getTime() / 1000) + 3600));
});