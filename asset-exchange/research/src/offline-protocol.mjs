// Executable OFFLINE specification. All observations/receipts are unverified public model inputs.
// Replay is the only state constructor: no caller-supplied snapshot can enable a transition.
import {exactObject, requireThat, text, safeTime, digest, dataHash, canonical, offline} from './offline-data.mjs';
import {evaluateOfflineEvidence} from './offline-evidence.mjs';

const ID = /^[A-Za-z0-9:-]{8,96}$/, LEGS = ['A', 'B'];
const REPORT_KEYS = ['schemaVersion', 'source', 'termsDigest', 'networkDigest', 'epoch', 'blockHash', 'height', 'tipHeight', 'observedAt', 'outcome', 'planDigest'];
const OUTCOMES = ['LOCKED', 'CLAIMED', 'REFUNDED', 'UNFUNDED'];
const PLAN_FIELDS = {LOCKED: 'lockPlanDigest', CLAIMED: 'claimPlanDigest', REFUNDED: 'refundPlanDigest', UNFUNDED: 'unfundedPlanDigest'};
const BUDGETS = ['inclusionB', 'observationB', 'claimA', 'reorg', 'signerOutage', 'clockError'];

export function validateOfflineProtocolConfig(config) {
  canonical(config);
  exactObject(config, ['schemaVersion', 'tradeId', 'termsDigest', 'rolesDigest', 'secretCommitment', 'legs', 'recovery', 'timing'], 'protocol config');
  requireThat(config.schemaVersion === 1, 'protocol schema version'); text(config.tradeId, ID, 'trade');
  for (const name of ['termsDigest', 'rolesDigest', 'secretCommitment']) digest(config[name], name);
  exactObject(config.legs, LEGS, 'legs');
  const plans = new Set();
  for (const name of LEGS) {
    const leg = config.legs[name];
    exactObject(leg, ['asset', 'network', 'genesis', ...Object.values(PLAN_FIELDS), 'policy'], 'leg config');
    // A separate chain adapter/qualification is required even for these three script families.
    requireThat(['BTC', 'DOGE', 'LTC'].includes(leg.asset), 'this model is limited to script HTLC families; no BCH/FORKID, XMR or SOL substitution');
    requireThat(leg.network === 'synthetic-offline', 'only synthetic offline identity permitted'); digest(leg.genesis, 'genesis');
    for (const field of Object.values(PLAN_FIELDS)) {
      digest(leg[field], field); requireThat(!plans.has(leg[field]), 'ambiguous branch/leg plan digest'); plans.add(leg[field]);
    }
    const p = leg.policy;
    requireThat(p.termsDigest === config.termsDigest && p.networkDigest === dataHash({asset: leg.asset, network: leg.network, genesis: leg.genesis}), 'policy identity mismatch');
    requireThat(p.epoch === 0, 'initial epoch must be zero');
    // Exercise the existing strict policy schema without treating this dummy input as evidence.
    evaluateOfflineEvidence([{schemaVersion: 1, source: p.sources?.[0]?.id, termsDigest: config.termsDigest,
      networkDigest: p.networkDigest, epoch: 0, blockHash: '0'.repeat(64), height: 0, tipHeight: 0,
      observedAt: 0, outcome: 'UNFUNDED', planDigest: leg.unfundedPlanDigest}], p, 0);
  }
  requireThat(config.legs.A.asset !== config.legs.B.asset, 'two distinct asset profiles required');
  exactObject(config.recovery, ['bundleDigest', 'restoreReceiptDigest', 'feeBudgetDigest'], 'recovery');
  Object.entries(config.recovery).forEach(([key, value]) => digest(value, key));
  const t = config.timing;
  exactObject(t, ['domain', 'longDeadline', 'shortDeadline', 'validUntil', 'measurementsDigest', ...BUDGETS], 'timing');
  requireThat(t.domain === 'SIMULATED_COMMON_SECONDS', 'no implicit block-height/time conversion'); digest(t.measurementsDigest, 'measurements');
  for (const key of ['longDeadline', 'shortDeadline', 'validUntil', ...BUDGETS]) safeTime(t[key], key);
  requireThat(BUDGETS.every(key => t[key] > 0), 'positive explicit timing budgets required');
  const margin = BUDGETS.reduce((sum, key) => sum + t[key], 0);
  requireThat(Number.isSafeInteger(margin) && t.longDeadline - t.shortDeadline >= margin, 'insufficient asymmetric deadline margin');
  return offline({configDigest: dataHash(config), nativeEvidenceVerified: false});
}

function eventShape(event, config) {
  canonical(event);
  exactObject(event, ['schemaVersion', 'id', 'tradeId', 'termsDigest', 'at', 'type', 'payload'], 'protocol event');
  requireThat(event.schemaVersion === 1 && event.tradeId === config.tradeId && event.termsDigest === config.termsDigest, 'event terms/trade/version mismatch');
  text(event.id, ID, 'event id'); safeTime(event.at, 'event time');
  const fields = {
    VALIDATE_TERMS: ['validationReceiptDigest'], FREEZE_PARTICIPANTS: ['rolesDigest'],
    PREPARE_RECOVERY: ['bundleDigest', 'restoreReceiptDigest', 'feeBudgetDigest'],
    LOCK_OBSERVED: ['leg', 'reports'], LOCK_CONFIRMED: ['leg', 'reports'],
    CLAIM_ELIGIBLE_IN_MODEL: ['measurementsDigest'], SPEND_OBSERVED: ['leg', 'outcome', 'reports', 'timeoutReceiptDigest'],
    SECRET_OBSERVED_IN_MODEL: ['commitment', 'sourceSpendDigest'],
    REORG: ['leg', 'newEpoch'], RPC_ERROR: ['leg', 'operationClass', 'requestDigest'],
    UNAVAILABLE: ['reason'], CLOCK: [], CANCEL: [], FAIL: [],
    RECONCILE: ['reportsA', 'reportsB', 'reviewReceiptDigest'],
  };
  requireThat(Object.hasOwn(fields, event.type), 'unsupported protocol event; no executable operation exists');
  exactObject(event.payload, fields[event.type], 'event payload');
  if (Object.hasOwn(event.payload, 'leg')) requireThat(LEGS.includes(event.payload.leg), 'unknown leg');
  requireThat(Buffer.byteLength(JSON.stringify(canonical(event))) <= 32768, 'protocol event exceeds bound');
}

function inspectReports(config, state, legName, reports, now, minimumConfirmations, expectedOutcome = null) {
  const leg = config.legs[legName], policy = {...leg.policy, epoch: state.legs[legName].epoch, minimumConfirmations};
  requireThat(Array.isArray(reports) && reports.length > 0 && reports.length <= policy.sources.length, 'bounded reports required');
  // Validate before persisting. Digest-only receipts never admit preimages, tx bytes or arbitrary fields.
  for (const report of reports) {
    exactObject(report, REPORT_KEYS, 'protocol report');
    for (const key of ['termsDigest', 'networkDigest', 'blockHash', 'planDigest']) digest(report[key], key);
    text(report.source, /^[A-Za-z0-9:-]{1,64}$/, 'source');
    requireThat(report.schemaVersion === 1 && OUTCOMES.includes(report.outcome), 'report version/outcome');
    for (const key of ['epoch', 'height', 'tipHeight', 'observedAt']) safeTime(report[key], key);
    requireThat(report.tipHeight >= report.height && report.observedAt <= now, 'report height/time mismatch');
  }
  // Wrong amount/script/outpoint or branch is represented by a different frozen plan digest.
  const bindingMismatch = reports.some(r => r.termsDigest !== config.termsDigest || r.networkDigest !== policy.networkDigest);
  let assessment;
  if (bindingMismatch) assessment = {status: 'HOLD', reasons: ['REPORT_BINDING_MISMATCH']};
  else assessment = evaluateOfflineEvidence(reports, policy, now);
  const reasons = [...assessment.reasons];
  if (reports.some(r => r.planDigest !== leg[PLAN_FIELDS[r.outcome]])) reasons.push('PLAN_MISMATCH');
  if (expectedOutcome && reports.some(r => r.outcome !== expectedOutcome)) reasons.push('UNEXPECTED_OUTCOME');
  for (const r of reports) {
    const previous = state.legs[legName].sourceObservations['source:' + r.source];
    if (!previous || r.epoch !== previous.epoch) continue;
    if (r.observedAt < previous.observedAt) reasons.push('REGRESSING_SOURCE_OBSERVATION');
    if (r.tipHeight < previous.tipHeight) reasons.push('REGRESSING_CHAIN_TIP_REQUIRES_EPOCH');
    if (['CLAIMED', 'REFUNDED'].includes(previous.outcome) && r.outcome !== previous.outcome) reasons.push('RESOLUTION_CHANGED_WITHOUT_EPOCH');
    if (previous.outcome === 'LOCKED' && r.outcome === 'UNFUNDED') reasons.push('LOCK_DISAPPEARED_REQUIRES_RECONCILIATION');
    if (previous.outcome === r.outcome && r.outcome !== 'UNFUNDED' && (previous.blockHash !== r.blockHash || previous.height !== r.height)) reasons.push('INCLUSION_CHANGED_WITHOUT_EPOCH');
  }
  return {ok: reasons.length === 0, reasons: [...new Set(reasons)], reports, digest: dataHash(reports), outcome: reports[0].outcome,
    observedAt: Math.min(...reports.map(r => r.observedAt)), exposurePossible: reports.some(r => r.outcome !== 'UNFUNDED')};
}

function emptyLeg() { return {epoch: 0, everExposed: false, observed: false, confirmed: false, lockObservedAt: null, lockReceipt: null, resolution: null, spendReceipt: null, sourceObservations: {}}; }
function rememberEvidence(leg, evidence) {
  for (const r of evidence.reports) leg.sourceObservations['source:' + r.source] = {epoch: r.epoch, observedAt: r.observedAt,
    tipHeight: r.tipHeight, blockHash: r.blockHash, height: r.height, outcome: r.outcome};
}
function remainingSafe(config, now) {
  const t = config.timing, remaining = BUDGETS.reduce((sum, key) => sum + t[key], 0);
  return now < t.validUntil && t.shortDeadline - now > remaining;
}
function freshLocks(config, state, now) {
  return LEGS.every(name => state.legs[name].confirmed && now - state.legs[name].lockObservedAt <= config.legs[name].policy.maximumAge);
}
function hasExposure(state) { return LEGS.some(name => state.legs[name].everExposed); }
function hold(state, reasons, mode = 'HOLD') {
  // A contradictory resolution is an incident; later operational uncertainty cannot downgrade it.
  state.mode = state.mode === 'INCIDENT' || reasons.includes('RESOLUTION_CHANGED_WITHOUT_EPOCH') ? 'INCIDENT' : mode;
  state.reasons = reasons;
}
function requireActive(state, phase) { requireThat(state.mode === 'ACTIVE' && state.phase === phase, 'out-of-order or suspended protocol transition'); }
function receipt(value, name) { digest(value, name); requireThat(value !== '0'.repeat(64), 'empty receipt digest'); }

export function replayOfflineProtocol(config, events) {
  const validation = validateOfflineProtocolConfig(config);
  canonical(events); requireThat(Array.isArray(events) && events.length <= 64, 'bounded protocol event list required');
  const state = {schemaVersion: 1, tradeId: config.tradeId, configDigest: validation.configDigest, termsDigest: config.termsDigest,
    phase: 'OFFER_CREATED', mode: 'ACTIVE', lastEventAt: 0, recoveryPrepared: false, reasons: [],
    legs: {A: emptyLeg(), B: emptyLeg()}, secretReceipt: null, eventDigests: {},
    nativeEvidenceVerified: false, recoveryActuallyVerified: false, qualificationStatus: 'BLOCKED'};
  for (const event of events) {
    eventShape(event, config); const hash = dataHash(event);
    if (Object.hasOwn(state.eventDigests, event.id)) {
      requireThat(state.eventDigests[event.id] === hash, 'conflicting protocol event replay'); continue;
    }
    requireThat(event.at >= state.lastEventAt, 'event time moved backwards');
    requireThat(Object.keys(state.eventDigests).length < 48, 'unique protocol event bound exceeded');
    const p = event.payload, now = event.at;
    if (state.mode === 'CLOSED') {
      const riskObservation = ['LOCK_OBSERVED', 'LOCK_CONFIRMED', 'SPEND_OBSERVED', 'RECONCILE'].includes(event.type);
      const exposureAlert = event.type === 'REORG' && hasExposure(state);
      const uncertainEffect = event.type === 'RPC_ERROR' && p.operationClass === 'MAY_HAVE_MUTATED';
      requireThat(riskObservation || exposureAlert || uncertainEffect, 'closed protocol state cannot be rewritten by operational events');
    }
    switch (event.type) {
      case 'VALIDATE_TERMS':
        requireActive(state, 'OFFER_CREATED'); receipt(p.validationReceiptDigest, 'terms validation'); state.phase = 'TERMS_VALIDATED'; break;
      case 'FREEZE_PARTICIPANTS':
        requireActive(state, 'TERMS_VALIDATED'); requireThat(p.rolesDigest === config.rolesDigest, 'participant roles mismatch'); state.phase = 'PARTICIPANTS_FROZEN'; break;
      case 'PREPARE_RECOVERY':
        requireActive(state, 'PARTICIPANTS_FROZEN'); requireThat(dataHash(p) === dataHash(config.recovery), 'recovery receipt mismatch');
        state.recoveryPrepared = true; state.phase = 'RECOVERY_PREPARED'; break;
      case 'LOCK_OBSERVED': case 'LOCK_CONFIRMED': {
        const leg = state.legs[p.leg], confirmation = event.type === 'LOCK_CONFIRMED';
        const e = inspectReports(config, state, p.leg, p.reports, now, confirmation ? config.legs[p.leg].policy.minimumConfirmations : 1, 'LOCKED');
        leg.everExposed ||= e.exposurePossible;
        if (!e.ok) { hold(state, e.reasons); break; }
        rememberEvidence(leg, e);
        const predecessor = confirmation ? p.leg + '_LOCK_OBSERVED' : p.leg === 'A' ? 'RECOVERY_PREPARED' : 'A_CONFIRMED';
        if (state.mode !== 'ACTIVE' || state.phase !== predecessor || !state.recoveryPrepared) { hold(state, ['UNEXPECTED_LOCK_OBSERVATION'], 'INCIDENT'); break; }
        if (!remainingSafe(config, now) || (p.leg === 'B' && (!state.legs.A.confirmed || now - state.legs.A.lockObservedAt > config.legs.A.policy.maximumAge))) {
          hold(state, ['INSUFFICIENT_OR_STALE_TIMING'], 'RECOVERY_ONLY'); break;
        }
        leg.observed = true; leg.confirmed = confirmation; leg.lockObservedAt = e.observedAt; leg.lockReceipt = e.digest;
        state.phase = confirmation ? p.leg + '_CONFIRMED' : p.leg + '_LOCK_OBSERVED'; break;
      }
      case 'CLAIM_ELIGIBLE_IN_MODEL':
        requireActive(state, 'B_CONFIRMED'); requireThat(p.measurementsDigest === config.timing.measurementsDigest, 'timing measurement binding');
        if (!freshLocks(config, state, now) || !remainingSafe(config, now)) hold(state, ['CLAIM_MARGIN_OR_EVIDENCE_EXPIRED'], 'RECOVERY_ONLY');
        else state.phase = 'CLAIM_ELIGIBLE_IN_MODEL'; break;
      case 'SPEND_OBSERVED': {
        requireThat(['CLAIMED', 'REFUNDED'].includes(p.outcome), 'unknown spend outcome');
        if (p.outcome === 'REFUNDED') receipt(p.timeoutReceiptDigest, 'chain timeout receipt');
        else requireThat(p.timeoutReceiptDigest === null, 'claim cannot carry refund timeout');
        const leg = state.legs[p.leg], e = inspectReports(config, state, p.leg, p.reports, now, config.legs[p.leg].policy.minimumConfirmations, p.outcome);
        leg.everExposed ||= e.exposurePossible;
        if (!e.ok) { hold(state, e.reasons); break; }
        rememberEvidence(leg, e);
        const expectedPhase = p.leg === 'B' ? 'CLAIM_ELIGIBLE_IN_MODEL' : 'SECRET_OBSERVED_IN_MODEL';
        const expectedClaim = p.outcome === 'CLAIMED' && state.mode === 'ACTIVE' && state.phase === expectedPhase && freshLocks(config, state, now) && remainingSafe(config, now);
        if (leg.resolution && leg.resolution !== p.outcome) hold(state, ['CONFLICTING_SPEND'], 'INCIDENT');
        else if (p.outcome === 'CLAIMED' && !expectedClaim) hold(state, ['UNEXPECTED_CLAIM_OBSERVATION'], 'INCIDENT');
        else if (p.outcome === 'REFUNDED') hold(state, ['REFUND_REQUIRES_BOTH_LEG_RECONCILIATION'], 'RECOVERY_ONLY');
        // Observations of an unexpected effect are retained; rejecting a command must not erase an effect.
        leg.resolution = p.outcome; leg.spendReceipt = e.digest;
        state.phase = p.leg + (p.outcome === 'CLAIMED' ? '_CLAIM_OBSERVED' : '_REFUND_OBSERVED'); break;
      }
      case 'SECRET_OBSERVED_IN_MODEL':
        digest(p.commitment, 'commitment'); digest(p.sourceSpendDigest, 'spend receipt');
        if (p.commitment !== config.secretCommitment || p.sourceSpendDigest !== state.legs.B.spendReceipt ||
            state.mode !== 'ACTIVE' || state.phase !== 'B_CLAIM_OBSERVED' || state.legs.B.resolution !== 'CLAIMED' || !remainingSafe(config, now)) {
          hold(state, ['EARLY_UNBOUND_OR_LATE_SECRET_RECEIPT'], 'INCIDENT'); break;
        }
        state.secretReceipt = dataHash(p); state.phase = 'SECRET_OBSERVED_IN_MODEL'; break;
      case 'REORG':
        requireThat(Number.isSafeInteger(p.newEpoch) && p.newEpoch === state.legs[p.leg].epoch + 1, 'reorg must advance exactly one epoch');
        state.legs[p.leg].epoch = p.newEpoch;
        state.legs[p.leg].sourceObservations = {};
        // Preserve exposure and epochs, invalidate both legs' combined safety decision.
        for (const name of LEGS) Object.assign(state.legs[name], {confirmed: false, resolution: null, spendReceipt: null, lockReceipt: null});
        state.secretReceipt = null; state.phase = 'RECONCILIATION_REQUIRED'; hold(state, ['REORG_REQUIRES_BOTH_LEGS'], 'HOLD'); break;
      case 'RPC_ERROR':
        digest(p.requestDigest, 'request'); requireThat(['READ', 'MAY_HAVE_MUTATED'].includes(p.operationClass), 'RPC error class');
        state.legs[p.leg].everExposed ||= p.operationClass === 'MAY_HAVE_MUTATED';
        hold(state, ['RPC_ERROR_IS_NOT_ABSENCE_OF_EFFECT']); break;
      case 'UNAVAILABLE':
        requireThat(['PARTICIPANT_DISAPPEARED', 'SIGNER_REFUSED', 'FEE_BUDGET_UNUSABLE', 'NETWORK_UNAVAILABLE', 'EVIDENCE_CONFLICT'].includes(p.reason), 'unavailable reason');
        hold(state, [p.reason], hasExposure(state) ? 'RECOVERY_ONLY' : 'HOLD'); break;
      case 'CLOCK':
        if (now >= config.timing.shortDeadline || now >= config.timing.validUntil || !remainingSafe(config, now)) {
          hold(state, [hasExposure(state) ? 'EXPIRY_REQUIRES_CHAIN_RECOVERY' : 'OFFER_EXPIRED'], hasExposure(state) ? 'RECOVERY_ONLY' : 'CLOSED');
          if (!hasExposure(state)) state.phase = 'EXPIRED';
        }
        break;
      case 'CANCEL': case 'FAIL':
        requireThat(!hasExposure(state) && state.mode !== 'CLOSED', 'cannot abandon possibly locked funds or alter a closed offer');
        state.mode = 'CLOSED'; state.phase = event.type === 'CANCEL' ? 'CANCELLED' : 'FAILED'; break;
      case 'RECONCILE': {
        receipt(p.reviewReceiptDigest, 'review'); const observations = {};
        for (const name of LEGS) {
          const e = inspectReports(config, state, name, p['reports' + name], now, config.legs[name].policy.minimumConfirmations);
          observations[name] = e; state.legs[name].everExposed ||= e.exposurePossible;
        }
        const failed = LEGS.flatMap(name => observations[name].reasons);
        const outcomes = LEGS.map(name => observations[name].outcome);
        const mixedSpend = outcomes.includes('CLAIMED') && outcomes.includes('REFUNDED');
        if (failed.length) {
          if (mixedSpend) failed.push('MIXED_CLAIM_REFUND_INCIDENT');
          hold(state, failed, mixedSpend ? 'INCIDENT' : 'HOLD'); break;
        }
        for (const name of LEGS) {
          const leg = state.legs[name], e = observations[name];
          rememberEvidence(leg, e);
          leg.confirmed = e.outcome === 'LOCKED'; leg.observed = leg.confirmed;
          leg.lockObservedAt = leg.confirmed ? e.observedAt : null; leg.lockReceipt = leg.confirmed ? e.digest : null;
          leg.resolution = ['CLAIMED', 'REFUNDED'].includes(e.outcome) ? e.outcome : null;
          leg.spendReceipt = leg.resolution ? e.digest : null;
        }
        if (outcomes.every(o => o === 'CLAIMED')) { state.phase = 'RECONCILED_CLAIMS_IN_MODEL'; state.mode = 'CLOSED'; state.reasons = []; }
        else if (outcomes.includes('REFUNDED') && outcomes.every(o => ['REFUNDED', 'UNFUNDED'].includes(o))) {
          state.phase = 'RECONCILED_REFUNDS_IN_MODEL'; state.mode = 'CLOSED'; state.reasons = [];
        } else if (outcomes.includes('CLAIMED') && outcomes.includes('REFUNDED')) hold(state, ['MIXED_CLAIM_REFUND_INCIDENT'], 'INCIDENT');
        else hold(state, ['UNRESOLVED_OR_ABSENT_LOCKS_NO_AUTOMATIC_RESUME'], 'RECOVERY_ONLY');
        break;
      }
    }
    state.lastEventAt = now; state.eventDigests[event.id] = hash;
  }
  return offline(state);
}
