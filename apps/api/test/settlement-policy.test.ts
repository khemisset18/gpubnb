import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSettlement } from '../src/settlement.js';

test('pays only forty minutes and refunds twenty minutes of a one-hour booking', () => {
  const gross = 6_000n;
  const result = calculateSettlement(gross, 40 * 60, 60 * 60, 500);

  assert.equal(result.payableLamports, 4_000n);
  assert.equal(result.refundLamports, 2_000n);
  assert.equal(result.platformLamports, 200n);
  assert.equal(result.providerLamports, 3_800n);
  assert.equal(result.availabilityBps, 6_666);
  assert.equal(
    result.providerLamports + result.platformLamports + result.refundLamports,
    gross,
  );
});

test('does not grant full payment at ninety percent availability', () => {
  const result = calculateSettlement(10_000n, 54 * 60, 60 * 60, 0);

  assert.equal(result.payableLamports, 9_000n);
  assert.equal(result.refundLamports, 1_000n);
});

test('refunds the full escrow when no service time is validated', () => {
  const result = calculateSettlement(10_000n, 0, 3_600, 500);

  assert.equal(result.payableLamports, 0n);
  assert.equal(result.providerLamports, 0n);
  assert.equal(result.platformLamports, 0n);
  assert.equal(result.refundLamports, 10_000n);
});

test('rounding never overpays the provider and preserves the escrow invariant', () => {
  const result = calculateSettlement(100n, 1, 3, 500);

  assert.equal(result.payableLamports, 33n);
  assert.equal(result.refundLamports, 67n);
  assert.equal(
    result.providerLamports + result.platformLamports + result.refundLamports,
    100n,
  );
});

test('rejects unsafe or impossible duration values', () => {
  assert.throws(() => calculateSettlement(100n, -1, 60), /invalid duration/);
  assert.throws(() => calculateSettlement(100n, 61, 60), /invalid duration/);
  assert.throws(() => calculateSettlement(100n, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1), /invalid duration/);
});
