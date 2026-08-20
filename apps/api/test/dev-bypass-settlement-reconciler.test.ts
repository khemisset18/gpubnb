import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { devBypassSettlementSignature } from '../src/dev-booking-reconciler.js';

// Without a deployed escrow program, a DEGRADED/COMPLETED booking could never reach a
// real settlement (requestSettlement/confirmSettlement are otherwise only driven by the
// internal settlement service with a real signed Solana transaction), so it stayed stuck
// on an open payment forever - which in turn permanently tripped
// archiveLegacyFullMachineListing's listing_has_live_booking check for any listing
// carrying one. This is the dev-bypass-only symmetric counterpart to the existing
// AWAITING_DEPOSIT -> FUNDED bypass.

test('reconcileDevBypassSettlements only ever runs while the dev-bypass gate is active', async () => {
  const source = await readFile(new URL('../src/dev-booking-reconciler.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function reconcileDevBypassSettlements');
  assert.ok(start >= 0, 'the dev-bypass settlement reconciler must exist');
  const end = source.indexOf('\n}', source.indexOf('return { settled }', start + 1));
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /if\(!betaTestDevBypassActive\(\)\)return\{settled\}/,
    'must fail closed (no-op) unless betaTestDevBypassActive() - never runs once real escrow is configured',
  );
  assert.match(
    body,
    /status:\{in:\[BookingStatus\.DEGRADED,BookingStatus\.COMPLETED\]\}/,
    'must only ever touch bookings already in a settleable terminal-ish state',
  );
  assert.match(
    body,
    /endsAt:\{lt:now\}/,
    'must only ever touch a booking whose time window has fully elapsed',
  );
  assert.match(
    body,
    /payment:\{status:PaymentStatus\.ESCROW_FUNDED\}/,
    'must only ever touch a booking with an actual open dev-bypass payment to resolve',
  );
  assert.match(body, /awaitrequestSettlement\(db,booking\.id\)/, 'must go through the real settlement request path, not a shortcut');
  assert.match(body, /awaitconfirmSettlement\(db,booking\.id,/, 'must go through the real settlement confirmation path, not a shortcut');
});

test('the synthetic dev-bypass settlement signature is always a valid base58 string, even from a cuid containing 0 or l', () => {
  // Mirrors settlement-transactions.ts SIGNATURE_PATTERN exactly.
  const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/;
  assert.match(devBypassSettlementSignature('cml0abc123def456ghi789jkl0mno'), SIGNATURE_PATTERN);
  assert.match(devBypassSettlementSignature('cmskx44y30016dx1bw861a8w8'), SIGNATURE_PATTERN);
  assert.match(devBypassSettlementSignature('nozerosoralsinthisid'), SIGNATURE_PATTERN);
});

test('the synthetic dev-bypass settlement signature is deterministic and unique per booking', () => {
  assert.equal(
    devBypassSettlementSignature('cmskx44y30016dx1bw861a8w8'),
    devBypassSettlementSignature('cmskx44y30016dx1bw861a8w8'),
  );
  assert.notEqual(
    devBypassSettlementSignature('booking-a'),
    devBypassSettlementSignature('booking-b'),
  );
});

test('the reconciliation interval runs the dev-bypass settlement reconciler on every tick, independently of the others failing', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const reconcileIntervalId=setInterval');
  assert.ok(start >= 0);
  const end = source.indexOf('\n', start);
  const line = source.slice(start, end);

  assert.match(line, /reconcileDevBypassSettlements/, 'the dev-bypass settlement reconciler must actually be wired into the running interval');
  assert.match(line, /Promise\.all\(/, 'all reconcilers must run concurrently on the same tick so one being slow does not delay the others');
});
