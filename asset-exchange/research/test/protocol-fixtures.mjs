// Explicitly fictitious public facts, not blockchain proofs, keys or transactions.
import {dataHash} from '../src/offline-data.mjs';
export const hash = name => dataHash({publicModelLabel: name});
export function configFixture() {
  const termsDigest = hash('terms');
  const leg = asset => {
    const network = 'synthetic-offline', genesis = hash(asset + ':genesis');
    return {asset, network, genesis, lockPlanDigest: hash(asset + ':lock'), claimPlanDigest: hash(asset + ':claim'),
      refundPlanDigest: hash(asset + ':refund'), unfundedPlanDigest: hash(asset + ':absence'),
      policy: {termsDigest, networkDigest: dataHash({asset, network, genesis}), epoch: 0, quorum: 2,
        minimumConfirmations: 3, maximumAge: 120, sources: [{id: 'source:1', independenceGroup: 'group:1'}, {id: 'source:2', independenceGroup: 'group:2'}]}};
  };
  return {schemaVersion: 1, tradeId: 'offline-trade:1', termsDigest, rolesDigest: hash('roles'), secretCommitment: hash('commitment'),
    legs: {A: leg('DOGE'), B: leg('BTC')}, recovery: {bundleDigest: hash('bundle'), restoreReceiptDigest: hash('restore'), feeBudgetDigest: hash('fees')},
    timing: {domain: 'SIMULATED_COMMON_SECONDS', longDeadline: 3000, shortDeadline: 2000, validUntil: 1000,
      measurementsDigest: hash('timing'), inclusionB: 10, observationB: 10, claimA: 10, reorg: 10, signerOutage: 10, clockError: 10}};
}
export function reportsFixture(config, leg, outcome, at, {confirmations = 3, epoch = 0} = {}) {
  const fields = {LOCKED: 'lockPlanDigest', CLAIMED: 'claimPlanDigest', REFUNDED: 'refundPlanDigest', UNFUNDED: 'unfundedPlanDigest'};
  return config.legs[leg].policy.sources.map(source => ({schemaVersion: 1, source: source.id, termsDigest: config.termsDigest,
    networkDigest: config.legs[leg].policy.networkDigest, epoch, blockHash: hash(leg + ':block:' + outcome + ':' + epoch), height: 100,
    tipHeight: 99 + confirmations, observedAt: at, outcome, planDigest: config.legs[leg][fields[outcome]]}));
}
export function eventFixture(config, type, payload, at = 100, id = 'event:' + at + ':' + type.toLowerCase().replaceAll('_', '-')) {
  return {schemaVersion: 1, id, tradeId: config.tradeId, termsDigest: config.termsDigest, at, type, payload};
}
export function preparedFixture(config) {
  return [eventFixture(config, 'VALIDATE_TERMS', {validationReceiptDigest: hash('validation')}, 100),
    eventFixture(config, 'FREEZE_PARTICIPANTS', {rolesDigest: config.rolesDigest}, 101),
    eventFixture(config, 'PREPARE_RECOVERY', {...config.recovery}, 102)];
}
export function lockedFixture(config) {
  const events = preparedFixture(config);
  for (const [index, leg] of ['A', 'B'].entries()) {
    const at = 103 + index * 2;
    events.push(eventFixture(config, 'LOCK_OBSERVED', {leg, reports: reportsFixture(config, leg, 'LOCKED', at, {confirmations: 1})}, at));
    events.push(eventFixture(config, 'LOCK_CONFIRMED', {leg, reports: reportsFixture(config, leg, 'LOCKED', at + 1)}, at + 1));
  }
  return events;
}
export function claimedFixture(config) {
  const events = lockedFixture(config);
  events.push(eventFixture(config, 'CLAIM_ELIGIBLE_IN_MODEL', {measurementsDigest: config.timing.measurementsDigest}, 107));
  const b = reportsFixture(config, 'B', 'CLAIMED', 108);
  events.push(eventFixture(config, 'SPEND_OBSERVED', {leg: 'B', outcome: 'CLAIMED', reports: b, timeoutReceiptDigest: null}, 108));
  events.push(eventFixture(config, 'SECRET_OBSERVED_IN_MODEL', {commitment: config.secretCommitment, sourceSpendDigest: dataHash(b)}, 109));
  events.push(eventFixture(config, 'SPEND_OBSERVED', {leg: 'A', outcome: 'CLAIMED', reports: reportsFixture(config, 'A', 'CLAIMED', 110), timeoutReceiptDigest: null}, 110));
  return events;
}
export function reconcileFixture(config, outcomeA, outcomeB, at = 120, epochA = 0) {
  return eventFixture(config, 'RECONCILE', {reportsA: reportsFixture(config, 'A', outcomeA, at, {epoch: epochA}),
    reportsB: reportsFixture(config, 'B', outcomeB, at), reviewReceiptDigest: hash('review')}, at);
}
