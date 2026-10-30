import test from 'node:test';
import assert from 'node:assert/strict';
import {dataHash} from '../src/offline-data.mjs';
import {validateOfflineProtocolConfig, replayOfflineProtocol} from '../src/offline-protocol.mjs';
import {hash, configFixture, eventFixture, reportsFixture, preparedFixture, lockedFixture, claimedFixture, reconcileFixture} from './protocol-fixtures.mjs';

function boundary(state) {
  assert.equal(state.simulationOnly, true); assert.equal(state.qualified, false); assert.equal(state.qualificationStatus, 'BLOCKED');
  assert.equal(state.nativeEvidenceVerified, false); assert.equal(state.recoveryActuallyVerified, false);
  assert.deepEqual(state.executableOperations, []); assert.ok(Object.isFrozen(state.legs.A));
}
test('full public model cycle keeps observations separate from confirmations and never authorizes execution', () => {
  const c = configFixture(), events = claimedFixture(c);
  const phases = ['TERMS_VALIDATED', 'PARTICIPANTS_FROZEN', 'RECOVERY_PREPARED', 'A_LOCK_OBSERVED', 'A_CONFIRMED', 'B_LOCK_OBSERVED',
    'B_CONFIRMED', 'CLAIM_ELIGIBLE_IN_MODEL', 'B_CLAIM_OBSERVED', 'SECRET_OBSERVED_IN_MODEL', 'A_CLAIM_OBSERVED'];
  for (let i = 0; i < events.length; i++) {
    const state = replayOfflineProtocol(c, events.slice(0, i + 1)); boundary(state); assert.equal(state.phase, phases[i]); assert.equal(state.mode, 'ACTIVE');
  }
  const state = replayOfflineProtocol(c, [...events, reconcileFixture(c, 'CLAIMED', 'CLAIMED')]);
  assert.equal(state.mode, 'CLOSED'); assert.equal(state.phase, 'RECONCILED_CLAIMS_IN_MODEL'); boundary(state);
  assert.equal(state.legs.A.everExposed, true);
});
test('configuration freezes roles, distinct plans, chain identity, budgets and synthetic-only network', () => {
  for (const mutate of [c => {c.legs.A.network = 'mainnet';}, c => {c.legs.B.asset = 'SOL';}, c => {c.legs.B.asset = 'XMR';},
    c => {c.legs.B.asset = 'BCH';}, c => {c.legs.A.policy.networkDigest = hash('wrong');}, c => {c.legs.A.policy.termsDigest = hash('wrong');},
    c => {c.legs.A.claimPlanDigest = c.legs.B.refundPlanDigest;}, c => {c.timing.domain = 'BLOCK_HEIGHT';},
    c => {c.timing.longDeadline = c.timing.shortDeadline + 1;}, c => {c.timing.reorg = 0;}, c => {c.qualified = true;}]) {
    const c = configFixture(); mutate(c); assert.throws(() => validateOfflineProtocolConfig(c));
  }
  const c = configFixture(), e = preparedFixture(c); e[1].payload.rolesDigest = hash('wrong roles');
  assert.throws(() => replayOfflineProtocol(c, e), /roles mismatch/);
  const recovery = preparedFixture(c); recovery[2].payload.feeBudgetDigest = hash('wrong fees');
  assert.throws(() => replayOfflineProtocol(c, recovery), /recovery receipt mismatch/);
});
test('exact event schema rejects executable or secret payloads, hostile properties and wrong identity', () => {
  const c = configFixture(), good = preparedFixture(c)[0];
  for (const bad of [{...good, tradeId: 'wrong-trade:1'}, {...good, termsDigest: hash('wrong')}, {...good, type: 'SIGN_AND_SEND'},
    {...good, payload: {...good.payload, preimage: 'not allowed'}}, {...good, qualified: true}]) assert.throws(() => replayOfflineProtocol(c, [bad]));
  let reads = 0; const bad = {...good}; Object.defineProperty(bad, 'payload', {enumerable: true, get() { reads++; return good.payload; }});
  assert.throws(() => replayOfflineProtocol(c, [bad])); assert.equal(reads, 0);
});
test('identical event replay is idempotent even after later events, altered replay and backward time reject', () => {
  const c = configFixture(), e = preparedFixture(c), state = replayOfflineProtocol(c, e);
  assert.deepEqual(replayOfflineProtocol(c, [...e, structuredClone(e[0])]), state);
  assert.throws(() => replayOfflineProtocol(c, [...e, {...e[0], at: 999}]), /conflicting protocol event replay/);
  assert.throws(() => replayOfflineProtocol(c, [...e, eventFixture(c, 'CLOCK', {}, 1)]), /backwards/);
  assert.throws(() => replayOfflineProtocol(c, Array(65).fill(e[0])), /bounded protocol/);
});
test('out-of-order lock effects are retained as exposure; cancellation and failure cannot discard them', () => {
  const c = configFixture(), e = eventFixture(c, 'LOCK_OBSERVED', {leg: 'B', reports: reportsFixture(c, 'B', 'LOCKED', 103)}, 103);
  const state = replayOfflineProtocol(c, [e]); assert.equal(state.mode, 'INCIDENT'); assert.equal(state.legs.B.everExposed, true);
  for (const type of ['CANCEL', 'FAIL']) assert.throws(() => replayOfflineProtocol(c, [e, eventFixture(c, type, {}, 104)]), /cannot abandon/);
  assert.throws(() => replayOfflineProtocol(c, [eventFixture(c, 'FREEZE_PARTICIPANTS', {rolesDigest: c.rolesDigest})]), /out-of-order/);
});
test('wrong amount/script/outpoint/branch plans hold and preserve possible exposure', () => {
  const c = configFixture();
  for (const label of ['amount', 'script', 'outpoint', 'destination', 'fee', 'branch']) {
    const reports = reportsFixture(c, 'A', 'LOCKED', 103); reports.forEach(r => {r.planDigest = hash('wrong ' + label);});
    const state = replayOfflineProtocol(c, [...preparedFixture(c), eventFixture(c, 'LOCK_OBSERVED', {leg: 'A', reports}, 103)]);
    assert.equal(state.mode, 'HOLD'); assert.ok(state.reasons.includes('PLAN_MISMATCH')); assert.equal(state.legs.A.everExposed, true); boundary(state);
  }
});
test('stale, minority conflicting, wrong-network and shallow reports cannot advance', () => {
  const c = configFixture();
  for (const mutate of [r => r.forEach(x => {x.observedAt = 0;}), r => {r[1].blockHash = hash('fork');},
    r => r.forEach(x => {x.networkDigest = hash('wrong network');}), r => r.forEach(x => {x.tipHeight = 100;})]) {
    const events = lockedFixture(c).slice(0, 4), reports = reportsFixture(c, 'A', 'LOCKED', 104); mutate(reports);
    const at = reports[0].observedAt === 0 ? 200 : 104;
    const state = replayOfflineProtocol(c, [...events, eventFixture(c, 'LOCK_CONFIRMED', {leg: 'A', reports}, at)]);
    assert.equal(state.mode, 'HOLD'); assert.equal(state.legs.A.confirmed, false); assert.equal(state.legs.A.everExposed, true);
  }
});
test('participant disappearance, refusal, unusable fee reserve and network loss retain recovery obligations', () => {
  const c = configFixture();
  for (const reason of ['PARTICIPANT_DISAPPEARED', 'SIGNER_REFUSED', 'FEE_BUDGET_UNUSABLE', 'NETWORK_UNAVAILABLE', 'EVIDENCE_CONFLICT']) {
    const events = [...lockedFixture(c), eventFixture(c, 'UNAVAILABLE', {reason}, 107)];
    const state = replayOfflineProtocol(c, events); assert.equal(state.mode, 'RECOVERY_ONLY'); assert.equal(state.legs.A.everExposed, true);
    assert.throws(() => replayOfflineProtocol(c, [...events, eventFixture(c, 'CLAIM_ELIGIBLE_IN_MODEL', {measurementsDigest: c.timing.measurementsDigest}, 108)]), /suspended/);
  }
});
test('RPC failure after possible admission never becomes evidence of no effect', () => {
  const c = configFixture(), events = [...preparedFixture(c), eventFixture(c, 'RPC_ERROR', {leg: 'A', operationClass: 'MAY_HAVE_MUTATED', requestDigest: hash('request')}, 103)];
  const state = replayOfflineProtocol(c, events); assert.equal(state.mode, 'HOLD'); assert.equal(state.legs.A.everExposed, true);
  assert.throws(() => replayOfflineProtocol(c, [...events, eventFixture(c, 'CANCEL', {}, 104)]), /cannot abandon/);
  const reconciled = replayOfflineProtocol(c, [...events, reconcileFixture(c, 'UNFUNDED', 'UNFUNDED')]);
  assert.equal(reconciled.legs.A.everExposed, true); assert.equal(reconciled.mode, 'RECOVERY_ONLY');
});
test('expiry before exposure closes only an offer; expiry after exposure executes no refund', () => {
  const c = configFixture(), clock = eventFixture(c, 'CLOCK', {}, 2000);
  const before = replayOfflineProtocol(c, [...preparedFixture(c), clock]); assert.equal(before.phase, 'EXPIRED'); assert.equal(before.mode, 'CLOSED');
  const after = replayOfflineProtocol(c, [...lockedFixture(c), clock]); assert.equal(after.mode, 'RECOVERY_ONLY');
  assert.equal(after.legs.A.resolution, null); assert.equal(after.legs.B.resolution, null); boundary(after);
});
test('stale measured budgets, stale lock facts and insufficient remaining margin prevent model claim eligibility', () => {
  const c = configFixture();
  for (const at of [300, 1000, 1990]) {
    const state = replayOfflineProtocol(c, [...lockedFixture(c), eventFixture(c, 'CLAIM_ELIGIBLE_IN_MODEL', {measurementsDigest: c.timing.measurementsDigest}, at)]);
    assert.equal(state.mode, 'RECOVERY_ONLY'); assert.equal(state.phase, 'B_CONFIRMED'); boundary(state);
  }
  const c2 = configFixture(); c2.timing.validUntil = 3000;
  const late = lockedFixture(c2).map(e => ({...e, at: e.at + 1833, payload: e.payload.reports ? {...e.payload, reports: e.payload.reports.map(r => ({...r, observedAt: r.observedAt + 1833}))} : e.payload}));
  const state = replayOfflineProtocol(c2, [...late, eventFixture(c2, 'CLAIM_ELIGIBLE_IN_MODEL', {measurementsDigest: c2.timing.measurementsDigest}, 1940)]);
  assert.equal(state.mode, 'RECOVERY_ONLY'); // strict remaining > 60, equality is insufficient
});
test('early, unbound or late secret receipts cause an incident and never expose a preimage', () => {
  const c = configFixture(), base = claimedFixture(c).slice(0, 9), spendDigest = dataHash(base.at(-1).payload.reports);
  for (const [events, payload, at] of [[preparedFixture(c), {commitment: c.secretCommitment, sourceSpendDigest: spendDigest}, 103],
    [base, {commitment: hash('wrong commitment'), sourceSpendDigest: spendDigest}, 109],
    [base, {commitment: c.secretCommitment, sourceSpendDigest: hash('wrong spend')}, 109],
    [base, {commitment: c.secretCommitment, sourceSpendDigest: spendDigest}, 2000]]) {
    const state = replayOfflineProtocol(c, [...events, eventFixture(c, 'SECRET_OBSERVED_IN_MODEL', payload, at)]);
    assert.equal(state.mode, 'INCIDENT'); assert.equal(state.secretReceipt, null); boundary(state);
  }
});
test('unexpected claims remain visible and conflicting refunds cannot become a clean success', () => {
  const c = configFixture(), claim = eventFixture(c, 'SPEND_OBSERVED', {leg: 'A', outcome: 'CLAIMED', reports: reportsFixture(c, 'A', 'CLAIMED', 103), timeoutReceiptDigest: null}, 103);
  const state = replayOfflineProtocol(c, [...preparedFixture(c), claim]); assert.equal(state.mode, 'INCIDENT'); assert.equal(state.legs.A.resolution, 'CLAIMED');
  const mixed = replayOfflineProtocol(c, [...claimedFixture(c), reconcileFixture(c, 'CLAIMED', 'REFUNDED')]);
  assert.equal(mixed.mode, 'INCIDENT'); assert.ok(mixed.reasons.includes('MIXED_CLAIM_REFUND_INCIDENT'));
});
test('refund observation requires a bound chain-time receipt, then two-leg reconciliation', () => {
  const c = configFixture(), spend = eventFixture(c, 'SPEND_OBSERVED', {leg: 'A', outcome: 'REFUNDED', reports: reportsFixture(c, 'A', 'REFUNDED', 110), timeoutReceiptDigest: hash('chain timeout')}, 110);
  const events = [...lockedFixture(c).slice(0, 5), spend], state = replayOfflineProtocol(c, events);
  assert.equal(state.mode, 'RECOVERY_ONLY'); assert.equal(state.legs.A.resolution, 'REFUNDED');
  const closed = replayOfflineProtocol(c, [...events, reconcileFixture(c, 'REFUNDED', 'UNFUNDED')]);
  assert.equal(closed.mode, 'CLOSED'); assert.equal(closed.phase, 'RECONCILED_REFUNDS_IN_MODEL'); boundary(closed);
  assert.throws(() => replayOfflineProtocol(c, [...lockedFixture(c), {...spend, payload: {...spend.payload, timeoutReceiptDigest: null}}]));
});
test('reorg reopens a model closure, invalidates both-leg decisions, preserves exposure and requires current epochs', () => {
  const c = configFixture(), events = [...claimedFixture(c), reconcileFixture(c, 'CLAIMED', 'CLAIMED'), eventFixture(c, 'REORG', {leg: 'A', newEpoch: 1}, 121)];
  const state = replayOfflineProtocol(c, events); assert.equal(state.mode, 'HOLD'); assert.equal(state.phase, 'RECONCILIATION_REQUIRED');
  assert.equal(state.legs.A.everExposed, true); assert.equal(state.legs.B.everExposed, true); assert.equal(state.legs.B.confirmed, false);
  assert.equal(state.legs.A.resolution, null); assert.equal(state.secretReceipt, null);
  const stale = replayOfflineProtocol(c, [...events, reconcileFixture(c, 'LOCKED', 'LOCKED', 122)]); assert.equal(stale.mode, 'INCIDENT');
  const impossible = replayOfflineProtocol(c, [...events, reconcileFixture(c, 'LOCKED', 'LOCKED', 122, 1)]); assert.equal(impossible.mode, 'INCIDENT');
  const fresh = replayOfflineProtocol(c, [...events, reconcileFixture(c, 'LOCKED', 'CLAIMED', 122, 1)]); assert.equal(fresh.mode, 'RECOVERY_ONLY');
  assert.throws(() => replayOfflineProtocol(c, [...events, eventFixture(c, 'REORG', {leg: 'A', newEpoch: 3}, 122)]), /exactly one/);
  assert.throws(() => replayOfflineProtocol(c, [...events, reconcileFixture(c, 'LOCKED', 'LOCKED', 122, 1), eventFixture(c, 'CANCEL', {}, 123)]), /cannot abandon/);
});
test('cancellation and failure exist only before exposure, neither enables future financial operations', () => {
  const c = configFixture();
  for (const type of ['CANCEL', 'FAIL']) {
    const state = replayOfflineProtocol(c, [...preparedFixture(c), eventFixture(c, type, {}, 103)]);
    assert.equal(state.mode, 'CLOSED'); boundary(state);
  }
});
