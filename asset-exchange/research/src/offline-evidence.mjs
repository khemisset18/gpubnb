// Offline quorum arithmetic; identity independence and reported chain facts remain explicit caller assumptions.
import {exactObject, requireThat, text, safeTime, digest, dataHash, offline} from './offline-data.mjs';
export function evaluateOfflineEvidence(reports, policy, now) {
  exactObject(policy, ['termsDigest', 'networkDigest', 'epoch', 'quorum', 'minimumConfirmations', 'maximumAge', 'sources'], 'policy');
  digest(policy.termsDigest, 'terms'); digest(policy.networkDigest, 'network'); safeTime(now, 'now');
  requireThat(Number.isSafeInteger(policy.epoch) && policy.epoch >= 0, 'invalid epoch');
  requireThat(Number.isSafeInteger(policy.quorum) && policy.quorum >= 2 && policy.quorum <= 8, 'invalid quorum');
  requireThat(Number.isSafeInteger(policy.minimumConfirmations) && policy.minimumConfirmations > 0 && policy.minimumConfirmations <= 10000, 'invalid confirmation budget');
  requireThat(Number.isSafeInteger(policy.maximumAge) && policy.maximumAge > 0 && policy.maximumAge <= 3600, 'invalid freshness budget');
  requireThat(Array.isArray(policy.sources) && policy.sources.length >= policy.quorum && policy.sources.length <= 8, 'bounded sources required');
  const groups = new Set(), sources = new Map();
  for (const s of policy.sources) {
    exactObject(s, ['id', 'independenceGroup'], 'source'); text(s.id, /^[A-Za-z0-9:-]{1,64}$/, 'source id'); text(s.independenceGroup, /^[A-Za-z0-9:-]{1,64}$/, 'source group');
    requireThat(!sources.has(s.id) && !groups.has(s.independenceGroup), 'duplicate source or independence group');
    sources.set(s.id, s.independenceGroup); groups.add(s.independenceGroup);
  }
  requireThat(Array.isArray(reports) && reports.length > 0 && reports.length <= policy.sources.length, 'bounded reports required');
  const used = new Set(), outcomes = new Set(), fresh = [];
  let stale = false, reorg = false, unconfirmed = false;
  for (const r of reports) {
    exactObject(r, ['schemaVersion', 'source', 'termsDigest', 'networkDigest', 'epoch', 'blockHash', 'height', 'tipHeight', 'observedAt', 'outcome', 'planDigest'], 'report');
    requireThat(r.schemaVersion === 1 && sources.has(r.source) && !used.has(r.source), 'unknown or replayed source'); used.add(r.source);
    requireThat(r.termsDigest === policy.termsDigest && r.networkDigest === policy.networkDigest, 'report binding mismatch');
    digest(r.blockHash, 'block'); digest(r.planDigest, 'plan');
    requireThat(Number.isSafeInteger(r.epoch) && r.epoch >= 0, 'invalid report epoch');
    safeTime(r.observedAt, 'observation'); requireThat(r.observedAt <= now, 'future report');
    requireThat(Number.isSafeInteger(r.height) && Number.isSafeInteger(r.tipHeight) && r.height >= 0 && r.tipHeight >= r.height, 'invalid heights');
    requireThat(['LOCKED', 'CLAIMED', 'REFUNDED', 'UNFUNDED'].includes(r.outcome), 'unknown outcome');
    stale ||= now - r.observedAt > policy.maximumAge;
    reorg ||= r.epoch !== policy.epoch;
    unconfirmed ||= r.tipHeight - r.height + 1 < policy.minimumConfirmations;
    // Quorum cannot erase even a minority conflicting observation.
    outcomes.add(dataHash({blockHash: r.blockHash, height: r.height, outcome: r.outcome, planDigest: r.planDigest}));
    fresh.push(r);
  }
  const reasons = [];
  if (outcomes.size !== 1) reasons.push('CONFLICTING_OBSERVATIONS');
  if (reorg) reasons.push('EPOCH_MISMATCH_REQUIRES_RECONCILIATION');
  if (stale) reasons.push('STALE_OBSERVATION');
  if (unconfirmed) reasons.push('INSUFFICIENT_CONFIRMATIONS');
  if (fresh.length < policy.quorum) reasons.push('INSUFFICIENT_QUORUM');
  return offline({status: reasons.length ? 'HOLD' : 'MODEL_QUORUM_UNDER_ASSUMPTIONS', reasons,
    epoch: policy.epoch, observationDigest: dataHash(reports), proofCryptographicallyVerified: false,
    independenceActuallyVerified: false, admissibleForExecution: false});
}
