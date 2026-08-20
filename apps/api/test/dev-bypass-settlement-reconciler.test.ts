import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// dev-booking-reconciler.ts imports config.ts, which validates process.env at module
// load time (see config.ts's top-level schema.parse). Some CI workflows (e.g.
// api-mining-ci.yml) only provision DATABASE_URL for this suite, not the rest of the
// required config - a plain top-level `import` would be hoisted above any env var
// this file sets, so the module (and this whole test file) must be loaded dynamically,
// after harmless fallback values are in place. Mirrors the pattern already used by
// orphaned-deposit-booking-reconciler.test.ts.
process.env.NODE_ENV ??= 'test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token-0123456789abcdef';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';

const { devBypassSettlementSignature } = await import('../src/dev-booking-reconciler.js');

// Without a deployed escrow program, a DEGRADED/COMPLETED booking could never reach a
// real settlement (requestSettlement/confirmSettlement are otherwise only driven by the
// internal settlement service with a real signed Solana transaction), so it stayed stuck
// on an open payment forever - which in turn permanently tripped
// archiveLegacyFullMachineListing's listing_has_live_booking check for any listing
// carrying one. This is the dev-bypass-only symmetric counterpart to the existing
// AWAITING_DEPOSIT -> FUNDED bypass.

test('findDevBypassSettlementCandidates matches COMPLETED regardless of endsAt, and DEGRADED only once endsAt has elapsed', async () => {
  const source = await readFile(new URL('../src/dev-booking-reconciler.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function findDevBypassSettlementCandidates');
  assert.ok(start >= 0, 'the candidate query must exist');
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /\{status:BookingStatus\.COMPLETED\}/,
    'COMPLETED already proves the workload finished successfully - must be settleable regardless of the nominal endsAt',
  );
  assert.match(
    body,
    /\{status:BookingStatus\.DEGRADED,endsAt:\{lt:now\}\}/,
    'DEGRADED may still be resolvable within its own window - must only touch one whose time window has fully elapsed',
  );
});

test('the dev-bypass open-payment filter excludes only already-terminal or FROZEN payments', async () => {
  const source = await readFile(new URL('../src/dev-booking-reconciler.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const openPayment');
  assert.ok(start >= 0, 'the shared open-payment filter must exist');
  const end = source.indexOf('};', start) + 2;
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /notIn:\[.*PaymentStatus\.RELEASED.*PaymentStatus\.FULLY_REFUNDED.*PaymentStatus\.FROZEN.*\]/s,
    'must exclude only already-terminal or FROZEN payments, not require one specific non-terminal status - ' +
    'reconcileStalledActivations already moves a degrading booking to SETTLEMENT_PENDING before this runs',
  );
});

test('reconcileDevBypassSettlements only ever runs while the dev-bypass gate is active, and surfaces per-booking failures', async () => {
  const source = await readFile(new URL('../src/dev-booking-reconciler.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function reconcileDevBypassSettlements');
  assert.ok(start >= 0, 'the dev-bypass settlement reconciler must exist');
  const end = source.indexOf('\n}', source.indexOf('return { settled, failed }', start + 1));
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /if\(!betaTestDevBypassActive\(\)\)return\{settled,failed\}/,
    'must fail closed (no-op) unless betaTestDevBypassActive() - never runs once real escrow is configured',
  );
  assert.match(
    body,
    /failed\.push\(\{bookingId:booking\.id,error:/,
    'a per-booking failure must be surfaced in the result, not swallowed silently - otherwise a persistent bug here is invisible from outside the process',
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
