import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateOfflineEvidence} from '../src/offline-evidence.mjs';
const h = c => c.repeat(64);
function fixture() {
  const policy = {termsDigest: h('a'), networkDigest: h('b'), epoch: 2, quorum: 2, minimumConfirmations: 6, maximumAge: 30,
    sources: [{id: 'one', independenceGroup: 'operator-one'}, {id: 'two', independenceGroup: 'operator-two'}, {id: 'three', independenceGroup: 'operator-three'}]};
  const reports = ['one', 'two'].map(source => ({schemaVersion: 1, source, termsDigest: h('a'), networkDigest: h('b'), epoch: 2,
    blockHash: h('c'), height: 100, tipHeight: 105, observedAt: 1000, outcome: 'LOCKED', planDigest: h('d')}));
  return {policy, reports};
}
test('fresh independent-source quorum remains explicitly an unverified model assumption', () => {
  const {policy, reports} = fixture(); const r = evaluateOfflineEvidence(reports, policy, 1030);
  assert.equal(r.status, 'MODEL_QUORUM_UNDER_ASSUMPTIONS'); assert.equal(r.proofCryptographicallyVerified, false);
  assert.equal(r.independenceActuallyVerified, false); assert.equal(r.admissibleForExecution, false);
  assert.deepEqual(r.executableOperations, []); assert.equal(r.qualified, false);
});
test('one dissenting report prevents majority from erasing a conflicting spend', () => {
  const {policy, reports} = fixture(); reports.push({...reports[0], source: 'three', outcome: 'REFUNDED'});
  const r = evaluateOfflineEvidence(reports, policy, 1030); assert.equal(r.status, 'HOLD');
  assert.ok(r.reasons.includes('CONFLICTING_OBSERVATIONS'));
});
test('reorg epochs, low confirmations, missing quorum and stale observations hold independently', () => {
  for (const [field, value, reason] of [['epoch', 1, 'EPOCH_MISMATCH_REQUIRES_RECONCILIATION'], ['observedAt', 999, 'STALE_OBSERVATION'], ['tipHeight', 104, 'INSUFFICIENT_CONFIRMATIONS']]) {
    const {policy, reports} = fixture(); reports[0][field] = value;
    assert.ok(evaluateOfflineEvidence(reports, policy, 1030).reasons.includes(reason));
  }
  const {policy, reports} = fixture(); assert.ok(evaluateOfflineEvidence(reports.slice(0, 1), policy, 1030).reasons.includes('INSUFFICIENT_QUORUM'));
});
test('source replay, source aliases and wrong bindings fail closed', () => {
  const {policy, reports} = fixture();
  assert.throws(() => evaluateOfflineEvidence([reports[0], reports[0]], policy, 1030), /replayed source/);
  const alias = structuredClone(policy); alias.sources[1].independenceGroup = alias.sources[0].independenceGroup;
  assert.throws(() => evaluateOfflineEvidence(reports, alias, 1030), /independence/);
  for (const [field, value] of [['networkDigest', h('e')], ['termsDigest', h('e')], ['observedAt', 1031], ['height', 106]]) {
    const changed = structuredClone(reports); changed[0][field] = value;
    assert.throws(() => evaluateOfflineEvidence(changed, policy, 1030));
  }
});
