// Offline design model only. No node, signer, wallet, transport or executor.
import {createHash} from 'node:crypto';

function requireThat(value, message) { if (!value) throw new Error(message); }
function integer(value, name) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), `${name}: canonical unsigned integer string required`);
  return BigInt(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  requireThat(value === null || ['string', 'boolean', 'number'].includes(typeof value), 'non-JSON event');
  if (typeof value === 'number') requireThat(Number.isSafeInteger(value), 'unsafe numeric event');
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const deepFreeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; };

export function coinQuoteToAtomic(decimal, decimals) {
  requireThat(Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 12, 'invalid decimals');
  requireThat(typeof decimal === 'string' && decimal.length <= 79 && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(decimal), 'decimal string required');
  const [whole, fraction = ''] = decimal.split('.');
  requireThat(fraction.length <= decimals, 'fractional atomic unit');
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

export function reserveFees({chain, unit, rateAtomic, sizes, quantumAtomic, commissionAtomic, availableAtomic}) {
  const allowed = {BTC: ['ATOMIC_PER_VBYTE', 'ATOMIC_PER_1000_BYTES'], DOGE: ['ATOMIC_PER_1000_BYTES'],
    LTC: ['ATOMIC_PER_VBYTE', 'ATOMIC_PER_1000_BYTES'], BCH: ['ATOMIC_PER_1000_BYTES', 'ATOMIC_ABSOLUTE'], XMR: ['ATOMIC_PER_WEIGHT']};
  requireThat(allowed[chain]?.includes(unit), 'fee unit incompatible with chain profile');
  requireThat(Array.isArray(sizes) && sizes.length > 0 && sizes.length <= 16, 'bounded scenarios required');
  const rate = integer(rateAtomic, 'rate'), quantum = integer(quantumAtomic, 'quantum');
  requireThat(rate > 0n && quantum > 0n, 'positive rate and quantum required');
  const costs = sizes.map(size => {
    const n = integer(size, 'size'); requireThat(n > 0n, 'positive size required');
    const raw = unit === 'ATOMIC_ABSOLUTE' ? rate : (rate * n + (unit === 'ATOMIC_PER_1000_BYTES' ? 999n : 0n)) / (unit === 'ATOMIC_PER_1000_BYTES' ? 1000n : 1n);
    return ((raw + quantum - 1n) / quantum) * quantum;
  });
  const network = costs.reduce((a, b) => a + b, 0n), commission = integer(commissionAtomic, 'commission');
  requireThat(network + commission <= integer(availableAtomic, 'available'), 'budget exceeds available amount');
  return deepFreeze({simulationOnly: true, qualified: false, costsAtomic: costs.map(String), networkReserveAtomic: String(network), commissionAtomic: String(commission), totalBudgetAtomic: String(network + commission)});
}

export function checkTimeoutBudget({domain, longDeadline, shortDeadline, inclusionB, observationB, claimA, reorg, signerOutage, clockError, validUntil}, now) {
  requireThat(domain === 'SIMULATED_COMMON_SECONDS', 'cross-chain heights require an independently reviewed conversion');
  requireThat(Number.isSafeInteger(now) && now >= 0, 'safe integer model time required');
  requireThat(integer(String(now), 'now') < integer(validUntil, 'validUntil'), 'stale timing measurement');
  const values = [inclusionB, observationB, claimA, reorg, signerOutage, clockError].map((v, i) => integer(v, 'budget ' + i));
  requireThat(values.every(v => v > 0n), 'explicit positive measured budgets required');
  const budget = values.reduce((a, b) => a + b, 0n);
  requireThat(integer(longDeadline, 'long deadline') - integer(shortDeadline, 'short deadline') >= budget, 'insufficient asymmetric refund margin');
  return {simulationOnly: true, qualified: false, requiredMarginSeconds: String(budget)};
}

export function checkRecoveryPlan(plan) {
  requireThat(plan?.backendIndependent === true && plan.restoreTested === true && plan.termsBound === true, 'independent restored recovery required');
  requireThat(plan.userControlsRequiredKeys === true && plan.backendHasSpendMaterial === false, 'noncustodial key boundary required');
  requireThat(plan.feeBudgetBound === true, 'explicit recovery fee budget required');
  requireThat(typeof plan.fundingMalleable === 'boolean', 'funding identity semantics required');
  if (plan.fundingMalleable || plan.fundingReplacementPossible === true) {
    requireThat(plan.canReconstructAndResign === true && plan.signerProfileTested === true, 'fixed pre-signed refund cannot cover changed funding identity');
  }
  return {simulationOnly: true, qualified: false, verdict: 'MODEL_ACCEPTS_UNDER_EXPLICIT_ASSUMPTIONS'};
}

export function createOfflineTrade({tradeId, termsDigest, networks}) {
  requireThat(typeof tradeId === 'string' && tradeId.length >= 8 && /^[a-f0-9]{64}$/.test(termsDigest), 'trade and terms required');
  requireThat(networks?.A && networks?.B && networks.A !== networks.B, 'two explicit distinct leg identities required');
  return deepFreeze({simulationOnly: true, qualified: false, executableOperations: [], tradeId, termsDigest, networks: structuredClone(networks), state: 'OFFER_CREATED', seen: {}, funded: {}, resolutions: {}});
}

function trustedModelEvidence(current, event) {
  const p = event.proof;
  requireThat(p?.termsDigest === current.termsDigest && p.network === current.networks[event.leg], 'evidence binding mismatch');
  requireThat(p.validated === true && p.fresh === true && p.independenceReviewed === true, 'unvalidated/stale model evidence');
  requireThat(Array.isArray(p.sources) && p.sources.length >= 2 && new Set(p.sources).size === p.sources.length && p.sources.every(s => typeof s === 'string' && s.length), 'duplicate/insufficient evidence sources');
  requireThat(p.finalEnough === true && p.conflict === false, 'uncertain chain outcome');
}

export function applyOfflineEvent(current, event) {
  requireThat(current?.simulationOnly === true && current.qualified === false && current.executableOperations.length === 0, 'offline model boundary');
  requireThat(typeof event?.id === 'string' && /^[a-zA-Z0-9:-]{8,128}$/.test(event.id) && event.tradeId === current.tradeId, 'event identity required');
  const digest = hash(event);
  if (current.seen[event.id]) { requireThat(current.seen[event.id] === digest, 'conflicting replay'); return current; }
  const chainAlert = ['REORG', 'UNCERTAIN'].includes(event.type);
  requireThat(!['COMPLETED', 'REFUNDED', 'CANCELLED', 'FAILED'].includes(current.state) || (chainAlert && ['COMPLETED', 'REFUNDED'].includes(current.state)), 'terminal state');
  const next = structuredClone(current); next.seen[event.id] = digest;
  const move = (from, to) => { requireThat(from.includes(current.state), 'out-of-order model event'); next.state = to; };
  switch (event.type) {
    case 'ACCEPT': move(['OFFER_CREATED'], 'OFFER_ACCEPTED'); break;
    case 'PRECONDITIONS': requireThat(event.checked === true, 'preconditions not proven'); move(['OFFER_ACCEPTED'], 'PRECONDITIONS_VERIFIED'); break;
    case 'CONTRACT_REVIEW': requireThat(event.reviewed === true, 'contract review missing'); move(['PRECONDITIONS_VERIFIED'], 'CONTRACTS_REVIEWED'); break;
    case 'RECOVERY': checkRecoveryPlan(event.plan); move(['CONTRACTS_REVIEWED'], 'RECOVERY_PREPARED'); break;
    case 'LOCK_OBSERVED':
      requireThat(['A', 'B'].includes(event.leg), 'unknown leg'); trustedModelEvidence(current, event);
      move(event.leg === 'A' ? ['RECOVERY_PREPARED'] : ['A_CONFIRMED'], event.leg + '_CONFIRMED');
      next.funded[event.leg] = true; break;
    case 'CLAIM_AUTHORIZED_IN_MODEL': move(['B_CONFIRMED'], 'CLAIM_ALLOWED_IN_MODEL'); break;
    case 'SPEND_OBSERVED':
      requireThat(current.funded[event.leg] === true, 'unfunded leg'); trustedModelEvidence(current, event);
      requireThat(['CLAIM', 'REFUND'].includes(event.spend), 'unknown spend type');
      if (event.spend === 'CLAIM') requireThat(['CLAIM_ALLOWED_IN_MODEL', 'CLAIM_OBSERVED'].includes(current.state), 'claim cannot follow unknown/refund state');
      if (event.spend === 'REFUND') requireThat(event.chainTimeoutSatisfied === true, 'wall-clock timeout is insufficient');
      requireThat(!current.resolutions[event.leg], 'conflicting leg resolution');
      next.resolutions[event.leg] = event.spend; next.state = event.spend + '_OBSERVED'; break;
    case 'FINAL_RECONCILIATION':
      requireThat(event.independentlyReconciled === true && event.unobservedLegsProvenUnfunded === true, 'terminal reconciliation required');
      requireThat(Object.keys(current.funded).length > 0 && Object.keys(current.funded).every(leg => current.resolutions[leg]), 'unresolved funding');
      if (Object.values(current.resolutions).every(v => v === 'CLAIM') && current.funded.A && current.funded.B) next.state = 'COMPLETED';
      else if (Object.values(current.resolutions).every(v => v === 'REFUND')) next.state = 'REFUNDED';
      else next.state = 'RECOVERY_INCIDENT';
      break;
    case 'UNCERTAIN': case 'REORG':
      next.invalidatedResolutions = structuredClone(current.resolutions);
      next.resolutions = {};
      next.state = ['COMPLETED', 'REFUNDED'].includes(current.state) ? 'RECOVERY_INCIDENT' : 'UNKNOWN_REQUIRES_RECONCILIATION';
      break;
    case 'RECONCILE':
      requireThat(['UNKNOWN_REQUIRES_RECONCILIATION', 'RECOVERY_INCIDENT'].includes(current.state), 'reconciliation not required');
      requireThat(Object.keys(current.funded).length > 0, 'pre-lock uncertainty cannot bypass preconditions and recovery');
      for (const leg of Object.keys(current.funded)) trustedModelEvidence(current, {leg, proof: event.proofs?.[leg]});
      requireThat(event.reviewedAfterIncident === true, 'incident review required');
      next.invalidatedResolutions = structuredClone(current.resolutions);
      next.resolutions = {};
      next.state = current.funded.B ? 'B_CONFIRMED' : current.funded.A ? 'A_CONFIRMED' : 'RECOVERY_PREPARED';
      break;
    case 'CANCEL': requireThat(!current.funded.A && !current.funded.B, 'cannot cancel locked funds'); next.state = 'CANCELLED'; break;
    case 'FAIL': requireThat(!current.funded.A && !current.funded.B, 'cannot abandon recovery after lock'); next.state = 'FAILED'; break;
    default: throw new Error('unknown model event');
  }
  return deepFreeze(next);
}
