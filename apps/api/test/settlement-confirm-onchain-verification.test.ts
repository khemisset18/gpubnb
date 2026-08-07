import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Regression for the settlement-verification audit: POST /internal/bookings/:id/settlement/confirm
// used to accept any base58-shaped string as "proof" of an on-chain settlement, with no
// verification at all — unlike the deposit confirmation route, which always verified on-chain.
// Same source-inspection style as the existing C7 test (workspace-preparation-race-safety.test.ts)
// and the GPU-exclusivity route test (gpu-exclusivity.test.ts) for a route that isn't practical
// to exercise end-to-end without a live Postgres + Solana RPC.

async function routeBody(): Promise<string> {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/internal/bookings/:id/settlement/confirm'");
  assert.ok(start >= 0, 'route not found');
  const end = source.indexOf('\napp.', start + 10);
  assert.ok(end > start);
  return source.slice(start, end);
}

test('1) real money is never assumed safe by default: the route only skips on-chain verification in the exact DEV_PAYMENT_BYPASS-outside-production condition already used on the funding side', async () => {
  const body = await routeBody();
  assert.ok(
    body.includes("config.NODE_ENV!=='production'&&config.DEV_PAYMENT_BYPASS==='true'"),
    'must reuse the identical bypass condition as delivery-worker.ts\'s reconcileDevelopmentBookings, not a looser or separately-defined one',
  );
});

test('2) an idempotent replay (signature already recorded) never re-triggers on-chain verification', async () => {
  const body = await routeBody();
  assert.ok(
    body.includes('alreadyRecorded?.settlementSignature') && body.includes('db.payment.findUnique'),
    'must check for an already-recorded settlement signature before deciding whether to verify on-chain',
  );
});

test('3) a signature is never accepted without on-chain proof unless the request is a bypass or an idempotent replay', async () => {
  const body = await routeBody();
  const gate = body.indexOf('if(!bypass&&!alreadyRecorded?.settlementSignature){');
  assert.ok(gate >= 0, 'the on-chain-verification branch must be gated on both conditions together');
  const gateBody = body.slice(gate, body.indexOf('confirmSettlement(db,id,signature)', gate));
  assert.ok(gateBody.includes("ESCROW_PROGRAM_ID==='NOT_DEPLOYED_YET'") && gateBody.includes('503'), 'must refuse cleanly (503) instead of crashing on an undeployed program id');
  assert.ok(gateBody.includes('previewSettlement('), 'must compute the exact expected payout before verifying, not trust a caller-supplied amount');
  assert.ok(gateBody.includes('verifySettlementTransaction('), 'must call the real on-chain verifier');
  assert.ok(gateBody.includes("if(!verified)return reply.code(409).send({error:'invalid_settlement_transaction'})"), 'a failed on-chain check must reject with 409 before ever calling confirmSettlement');
});

test('4) the on-chain verifier is given the exact off-chain-computed payout, not values it invents or trusts from the request body', async () => {
  const body = await routeBody();
  assert.ok(
    body.includes('providerLamports:preview.settlement.providerLamports') &&
    body.includes('platformLamports:preview.settlement.platformLamports') &&
    body.includes('refundLamports:preview.settlement.refundLamports'),
    'the amounts checked on-chain must come from previewSettlement, the same calculation confirmSettlement itself will redo inside its transaction',
  );
});

test('5) confirmSettlement (the idempotent, invariant-checked DB transaction) is still always the final step', async () => {
  const body = await routeBody();
  const confirmCallIndex = body.lastIndexOf('confirmSettlement(db,id,signature)');
  assert.ok(confirmCallIndex > body.indexOf('verifySettlementTransaction('), 'confirmSettlement must run after the on-chain gate, never before or in place of it');
});
