import test from 'node:test';
import assert from 'node:assert/strict';
import {coinQuoteToAtomic, reserveFees, checkTimeoutBudget, checkRecoveryPlan, createOfflineTrade, applyOfflineEvent} from '../src/swap-safety-model.mjs';
const terms = 'a'.repeat(64), tradeId = 'fixture-trade-01';
const recovery = {backendIndependent: true, restoreTested: true, termsBound: true, userControlsRequiredKeys: true, backendHasSpendMaterial: false, feeBudgetBound: true, fundingMalleable: true, canReconstructAndResign: true, signerProfileTested: true};
const event = (id, type, extra = {}) => ({id: 'event-' + id, tradeId, type, ...extra});
const proof = leg => ({termsDigest: terms, network: leg === 'A' ? 'fixture-doge-regtest' : 'fixture-btc-regtest', validated: true, fresh: true, independenceReviewed: true, sources: ['fixture-a', 'fixture-b'], finalEnough: true, conflict: false});
function prepared() {
  let state = createOfflineTrade({tradeId, termsDigest: terms, networks: {A: 'fixture-doge-regtest', B: 'fixture-btc-regtest'}});
  for (const e of [event('accept', 'ACCEPT'), event('precheck', 'PRECONDITIONS', {checked: true}), event('review', 'CONTRACT_REVIEW', {reviewed: true}), event('recovery', 'RECOVERY', {plan: recovery})]) state = applyOfflineEvent(state, e);
  return state;
}
function funded() { let state = prepared(); for (const leg of ['A', 'B']) state = applyOfflineEvent(state, event('lock-' + leg, 'LOCK_OBSERVED', {leg, proof: proof(leg)})); return state; }

test('decimal quotes preserve atomic units beyond floating point precision', () => {
  assert.equal(coinQuoteToAtomic('0.001', 8), '100000');
  assert.equal(coinQuoteToAtomic('9007199254740993.000000000001', 12), '9007199254740993000000000001');
  for (const bad of [0.001, '1e-3', '-1', '0.000000001', '01.0']) assert.throws(() => coinQuoteToAtomic(bad, 8));
});
test('DOGE serialized-byte reserve rounds upward and separates commission', () => {
  const q = reserveFees({chain: 'DOGE', unit: 'ATOMIC_PER_1000_BYTES', rateAtomic: '100000', sizes: ['1', '999', '1001'], quantumAtomic: '1', commissionAtomic: '7', availableAtomic: '300000'});
  assert.deepEqual(q.costsAtomic, ['100', '99900', '100100']); assert.equal(q.networkReserveAtomic, '200100'); assert.equal(q.commissionAtomic, '7');
  assert.throws(() => reserveFees({chain: 'DOGE', unit: 'ATOMIC_PER_VBYTE'}));
});
test('BCH absolute covenant fee is never multiplied by transaction size', () => {
  assert.deepEqual(reserveFees({chain: 'BCH', unit: 'ATOMIC_ABSOLUTE', rateAtomic: '1000', sizes: ['300', '600'], quantumAtomic: '1', commissionAtomic: '0', availableAtomic: '2000'}).costsAtomic, ['1000', '1000']);
});
test('XMR weight quantization and insufficient budgets fail closed', () => {
  const input = {chain: 'XMR', unit: 'ATOMIC_PER_WEIGHT', rateAtomic: '11', sizes: ['3'], quantumAtomic: '10', commissionAtomic: '0', availableAtomic: '40'};
  assert.deepEqual(reserveFees(input).costsAtomic, ['40']);
  assert.throws(() => reserveFees({...input, availableAtomic: '39'}));
  assert.throws(() => reserveFees({...input, sizes: [3]}));
});
test('timeout model rejects insufficient margin, stale data and unconverted cross-chain heights', () => {
  const p = {domain: 'SIMULATED_COMMON_SECONDS', longDeadline: '200', shortDeadline: '100', inclusionB: '10', observationB: '10', claimA: '20', reorg: '10', signerOutage: '20', clockError: '10', validUntil: '90'};
  assert.equal(checkTimeoutBudget(p, 20).requiredMarginSeconds, '80');
  assert.throws(() => checkTimeoutBudget({...p, longDeadline: '179'}, 20));
  assert.throws(() => checkTimeoutBudget(p, 90));
  assert.throws(() => checkTimeoutBudget({...p, domain: 'HEIGHT'}, 20));
});
test('a fixed pre-signed refund is rejected for malleable or replaceable funding', () => {
  assert.throws(() => checkRecoveryPlan({...recovery, canReconstructAndResign: false}));
  assert.throws(() => checkRecoveryPlan({...recovery, fundingMalleable: false, fundingReplacementPossible: true, signerProfileTested: false}));
  assert.throws(() => checkRecoveryPlan({...recovery, backendHasSpendMaterial: true}));
  assert.throws(() => checkRecoveryPlan({...recovery, restoreTested: false}));
});
test('locks cannot bypass recovery, ordering or chain-specific evidence', () => {
  const before = createOfflineTrade({tradeId, termsDigest: terms, networks: {A: 'a', B: 'b'}});
  assert.throws(() => applyOfflineEvent(before, event('premature', 'LOCK_OBSERVED', {leg: 'A', proof: proof('A')})));
  assert.throws(() => applyOfflineEvent(prepared(), event('wrongleg', 'LOCK_OBSERVED', {leg: 'B', proof: proof('B')})));
  for (const changed of [{network: 'mainnet'}, {termsDigest: 'b'.repeat(64)}, {fresh: false}, {sources: ['same', 'same']}, {conflict: true}]) {
    assert.throws(() => applyOfflineEvent(prepared(), event('badproof', 'LOCK_OBSERVED', {leg: 'A', proof: {...proof('A'), ...changed}})));
  }
});
test('duplicate delivery is idempotent; conflicting reuse of an ID is rejected after restart', () => {
  const state = prepared(), e = event('lock-once', 'LOCK_OBSERVED', {leg: 'A', proof: proof('A')});
  const once = applyOfflineEvent(state, e), restored = JSON.parse(JSON.stringify(once));
  assert.equal(applyOfflineEvent(restored, structuredClone(e)), restored);
  assert.throws(() => applyOfflineEvent(restored, {...e, type: 'CANCEL'}));
  assert.equal(state.funded.A, undefined);
});
test('reorg or uncertainty after both locks prevents further claim actions', () => {
  for (const kind of ['REORG', 'UNCERTAIN']) {
    const held = applyOfflineEvent(funded(), event('hold-' + kind, kind));
    assert.equal(held.state, 'UNKNOWN_REQUIRES_RECONCILIATION');
    assert.throws(() => applyOfflineEvent(held, event('claim-unsafe', 'CLAIM_AUTHORIZED_IN_MODEL')));
  }
});
test('timeout alone never reports a refund, and locked funds cannot be abandoned/cancelled', () => {
  const state = funded();
  for (const type of ['CANCEL', 'FAIL']) assert.throws(() => applyOfflineEvent(state, event('abandon-' + type, type)));
  assert.throws(() => applyOfflineEvent(state, event('early-refund', 'SPEND_OBSERVED', {leg: 'A', spend: 'REFUND', proof: proof('A'), chainTimeoutSatisfied: false})));
  assert.equal(state.state, 'B_CONFIRMED');
});
test('one spend cannot complete a swap; mixed principal outcomes require a recovery incident', () => {
  let state = applyOfflineEvent(funded(), event('permit-claim', 'CLAIM_AUTHORIZED_IN_MODEL'));
  state = applyOfflineEvent(state, event('claim-B', 'SPEND_OBSERVED', {leg: 'B', spend: 'CLAIM', proof: proof('B')}));
  assert.equal(state.state, 'CLAIM_OBSERVED');
  assert.throws(() => applyOfflineEvent(state, event('early-final', 'FINAL_RECONCILIATION', {independentlyReconciled: true, unobservedLegsProvenUnfunded: true})));
  state = applyOfflineEvent(state, event('refund-A', 'SPEND_OBSERVED', {leg: 'A', spend: 'REFUND', proof: proof('A'), chainTimeoutSatisfied: true}));
  state = applyOfflineEvent(state, event('final-mixed', 'FINAL_RECONCILIATION', {independentlyReconciled: true, unobservedLegsProvenUnfunded: true}));
  assert.equal(state.state, 'RECOVERY_INCIDENT'); assert.equal(state.qualified, false); assert.deepEqual(state.executableOperations, []);
});
test('two observed claims plus reconciliation complete only the non-executable model', () => {
  let state = applyOfflineEvent(funded(), event('permit-claims', 'CLAIM_AUTHORIZED_IN_MODEL'));
  for (const leg of ['A', 'B']) state = applyOfflineEvent(state, event('claim-' + leg, 'SPEND_OBSERVED', {leg, spend: 'CLAIM', proof: proof(leg)}));
  state = applyOfflineEvent(state, event('final-both', 'FINAL_RECONCILIATION', {independentlyReconciled: true, unobservedLegsProvenUnfunded: true}));
  assert.equal(state.state, 'COMPLETED'); assert.equal(state.qualified, false); assert.deepEqual(state.executableOperations, []);
  assert.throws(() => applyOfflineEvent(state, event('later-cancel', 'CANCEL')));
});

test('deep reorg after apparent completion invalidates spend evidence instead of preserving a terminal success', () => {
  let state = applyOfflineEvent(funded(), event('permit-deep', 'CLAIM_AUTHORIZED_IN_MODEL'));
  for (const leg of ['A', 'B']) state = applyOfflineEvent(state, event('deep-claim-' + leg, 'SPEND_OBSERVED', {leg, spend: 'CLAIM', proof: proof(leg)}));
  state = applyOfflineEvent(state, event('deep-final', 'FINAL_RECONCILIATION', {independentlyReconciled: true, unobservedLegsProvenUnfunded: true}));
  state = applyOfflineEvent(state, event('deep-reorg', 'REORG'));
  assert.equal(state.state, 'RECOVERY_INCIDENT'); assert.deepEqual(state.resolutions, {});
  assert.throws(() => applyOfflineEvent(state, event('cached-final', 'FINAL_RECONCILIATION', {independentlyReconciled: true, unobservedLegsProvenUnfunded: true})));
  assert.throws(() => applyOfflineEvent(state, event('partial-reconcile', 'RECONCILE', {reviewedAfterIncident: true, proofs: {A: proof('A')}})));
  const resumed = applyOfflineEvent(state, event('review-reconcile', 'RECONCILE', {reviewedAfterIncident: true, proofs: {A: proof('A'), B: proof('B')}}));
  assert.equal(resumed.state, 'B_CONFIRMED'); assert.deepEqual(resumed.resolutions, {});
});

test('unsafe time and prototype-shaped event identifiers are rejected', () => {
  assert.throws(() => checkTimeoutBudget({domain: 'SIMULATED_COMMON_SECONDS'}, Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => applyOfflineEvent(prepared(), {id: '__proto__', tradeId, type: 'CANCEL'}));
});

test('pre-lock uncertainty cannot be used to skip contract review and independent recovery', () => {
  const initial = createOfflineTrade({tradeId, termsDigest: terms, networks: {A: 'a', B: 'b'}});
  const held = applyOfflineEvent(initial, event('prelock-hold', 'UNCERTAIN'));
  assert.throws(() => applyOfflineEvent(held, event('prelock-bypass', 'RECONCILE', {reviewedAfterIncident: true, proofs: {}})));
  assert.equal(applyOfflineEvent(held, event('safe-cancel', 'CANCEL')).state, 'CANCELLED');
});
