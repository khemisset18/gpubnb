// Typed OFFLINE interface boundaries, not adapters, script interpreters or qualification authorities.
import {createHash} from 'node:crypto';
import {exactObject, requireThat, text, uint, digest, dataHash, canonical, offline} from './offline-data.mjs';

const DOGE_SOURCE = 'e0a1c157791544e818c901bd9341896965afbf9d', U64 = (1n << 64n) - 1n;
const PROFILES = {
  BTC: ['UTXO_P2WSH_CLTV', 'BIP143_SIGHASH_ALL', 'SAT_PER_VBYTE'],
  DOGE: ['UTXO_P2SH_CLTV_LEGACY', 'LEGACY_SIGHASH_ALL', 'KOINU_PER_KILOBYTE'],
  LTC: ['TRANSPARENT_P2WSH_CLTV', 'LTC_SEGWIT_V0_SIGHASH_ALL', 'LITOSHI_PER_VBYTE'],
  BCH: ['BCH_P2SH_CLTV_FORKID', 'BCH_SIGHASH_ALL_FORKID', 'SAT_PER_KILOBYTE'],
  XMR: ['CROSS_CURVE_ADAPTOR_PROTOCOL_REQUIRED', 'CROSS_CURVE_PROOF_REQUIRED', 'PICONERO_PER_WEIGHT'],
  SOL: ['DEDICATED_SWAP_PROGRAM_REQUIRED', 'SOLANA_ED25519_MESSAGE', 'LAMPORT_AND_COMPUTE_BUDGET'],
};
const GAPS = {
  BTC: ['PAIR_SPECIFIC_TWO_LEG_PROOFS', 'NATIVE_RECOVERY', 'INDEPENDENT_AUDIT'],
  DOGE: ['D2_SIGNED_CLAIM_REFUND', 'STANDARDNESS_AND_ADMISSION', 'LEGACY_MALLEABILITY_RECOVERY', 'AUXPOW_REORGS', 'D3_D9'],
  LTC: ['PINNED_TRANSPARENT_PROFILE', 'NATIVE_ADAPTER', 'RELAY_RECOVERY_REORG', 'MWEB_EXCLUDED'],
  BCH: ['FROZEN_CONSENSUS_VERSION', 'FORKID_DIGEST_VECTORS', 'NATIVE_HTLC_ADMISSION_AND_RECOVERY'],
  XMR: ['PAIR_SPECIFIC_CROSS_CURVE_PROTOCOL', 'DLEQ_AND_ADAPTOR_AUDIT', 'KEY_IMAGE_AND_RESCAN_RECOVERY'],
  SOL: ['SEPARATE_SWAP_PROGRAM', 'SBF_CPI_ACCOUNT_VALIDATION', 'FINALIZED_WATCHER', 'INDEPENDENT_RECOVERY'],
};
export function offlineChainRequirements(asset) {
  requireThat(Object.hasOwn(PROFILES, asset), 'unknown asset');
  const [mechanism, signingDomain, feeUnit] = PROFILES[asset];
  return offline({asset, mechanism, signingDomain, feeUnit, missingEvidence: [...GAPS[asset]], nativeQualification: 'NOT TESTED', financialExecutionAllowed: false});
}
export function validateOfflineChainDescriptor(descriptor) {
  canonical(descriptor);
  exactObject(descriptor, ['schemaVersion', 'asset', 'network', 'genesis', 'sourceCommit', 'mechanism', 'signingDomain', 'feeUnit', 'profileDigest'], 'chain descriptor');
  requireThat(descriptor.schemaVersion === 1 && descriptor.network === 'synthetic-offline', 'offline descriptor version/network');
  const expected = offlineChainRequirements(descriptor.asset);
  for (const field of ['mechanism', 'signingDomain', 'feeUnit']) requireThat(descriptor[field] === expected[field], 'incompatible chain ' + field);
  digest(descriptor.genesis, 'synthetic genesis bytes'); digest(descriptor.profileDigest, 'profile');
  text(descriptor.sourceCommit, /^[a-f0-9]{40}$/, 'source commit');
  if (descriptor.asset === 'DOGE') requireThat(descriptor.sourceCommit === DOGE_SOURCE, 'DOGE source is fixed to D0 source identity');
  return offline({descriptorDigest: dataHash(descriptor), identityActuallyVerified: false, financialExecutionAllowed: false});
}
function positive(value, name) { const n = uint(value, name, U64); requireThat(n > 0n, 'positive ' + name + ' required'); return n; }
function hashHex(name, bytes) { return createHash(name).update(bytes).digest('hex'); }
function scriptDetails(asset, details) {
  exactObject(details, ['fundingOutpoint', 'scriptHex', 'outputScriptHex', 'claimRoleDigest', 'refundRoleDigest', 'commitmentHex',
    'signatureHashType', 'refundLock', 'lockDomain', 'sequence'], 'UTXO details');
  exactObject(details.fundingOutpoint, ['txid', 'vout'], 'funding outpoint'); digest(details.fundingOutpoint.txid, 'txid');
  requireThat(details.fundingOutpoint.txid !== '0'.repeat(64) && Number.isSafeInteger(details.fundingOutpoint.vout) && details.fundingOutpoint.vout >= 0 && details.fundingOutpoint.vout < 0xffffffff, 'non-null bounded outpoint required');
  text(details.scriptHex, /^(?:[a-f0-9]{2}){1,520}$/, 'bounded public contract bytes');
  digest(details.claimRoleDigest, 'claim role'); digest(details.refundRoleDigest, 'refund role'); digest(details.commitmentHex, 'commitment');
  requireThat(details.claimRoleDigest !== details.refundRoleDigest, 'distinct roles required');
  const script = Buffer.from(details.scriptHex, 'hex');
  const output = ['BTC', 'LTC'].includes(asset) ? '0020' + hashHex('sha256', script) : 'a914' + hashHex('ripemd160', Buffer.from(hashHex('sha256', script), 'hex')) + '87';
  requireThat(details.outputScriptHex === output, 'contract/output hash mismatch');
  requireThat(details.signatureHashType === (asset === 'BCH' ? 0x41 : 1), 'wrong signature hash domain/type');
  requireThat(Number.isSafeInteger(details.refundLock) && details.refundLock > 0 && details.refundLock <= 0xffffffff &&
    details.sequence === 0xfffffffe, 'narrow preparation lock/sequence profile required');
  requireThat(details.lockDomain === (details.refundLock < 500000000 ? 'HEIGHT' : 'UNIX_TIME'), 'locktime domain mismatch');
  // Hash binding is real; script semantics, signature hashing, signatures and UTXOs are NOT verified.
}
function xmrDetails(details) {
  exactObject(details, ['protocolFamily', 'protocolReviewDigest', 'crossCurveProofReceiptDigest', 'adaptorTranscriptDigest',
    'keyShareCommitmentDigest', 'refundTranscriptDigest', 'keyImageWatchDigest', 'rescanCheckpointDigest'], 'XMR details');
  requireThat(details.protocolFamily === 'SEPARATELY_REVIEWED_ADAPTOR_SWAP', 'Monero cannot use a classical script HTLC');
  for (const [key, value] of Object.entries(details)) if (key !== 'protocolFamily') digest(value, key);
  // Receipts are assumptions. No cross-curve/key-image/Monero primitive is implemented here.
}
function solDetails(details) {
  exactObject(details, ['programPurpose', 'programIdHex', 'accountOwnerHex', 'escrowPdaHex', 'pdaSeedsDigest', 'authorityRolesDigest',
    'accountLayoutDigest', 'commitmentHex', 'expiryDomain', 'expiryValue', 'observationCommitment', 'rentReserveAtomic', 'priorityFeeBudgetAtomic'], 'SOL details');
  requireThat(details.programPurpose === 'ATOMIC_SWAP', 'rental escrow cannot qualify as a swap program');
  for (const key of ['programIdHex', 'accountOwnerHex', 'escrowPdaHex', 'pdaSeedsDigest', 'authorityRolesDigest', 'accountLayoutDigest', 'commitmentHex']) digest(details[key], key);
  requireThat(details.programIdHex !== '0'.repeat(64) && details.accountOwnerHex === details.programIdHex && details.escrowPdaHex !== details.programIdHex, 'program/owner/PDA binding mismatch');
  requireThat(details.expiryDomain === 'UNIX_SECONDS_CLOCK', 'explicit Clock-time profile required; no slot/time conversion');
  requireThat(positive(details.expiryValue, 'Clock expiry') <= (1n << 63n) - 1n, 'Clock expiry exceeds signed timestamp range');
  requireThat(details.observationCommitment === 'finalized', 'processed/confirmed is not finalized');
  positive(details.rentReserveAtomic, 'rent reserve'); positive(details.priorityFeeBudgetAtomic, 'priority fee budget');
  // No PDA derivation, account ownership/privilege, CPI, rent or finalized-state proof is verified.
}
export function validateOfflineChainPlan(descriptor, plan, expectedPlanDigest) {
  const binding = validateOfflineChainDescriptor(descriptor); canonical(plan); digest(expectedPlanDigest, 'independently expected plan');
  exactObject(plan, ['schemaVersion', 'termsDigest', 'descriptorDigest', 'recoveryDigest', 'amountAtomic', 'feeBudgetAtomic', 'destinationDigest', 'details'], 'chain plan');
  requireThat(plan.schemaVersion === 1 && plan.descriptorDigest === binding.descriptorDigest, 'plan chain/profile identity mismatch');
  for (const key of ['termsDigest', 'recoveryDigest', 'destinationDigest']) digest(plan[key], key);
  const amount = positive(plan.amountAtomic, 'amount'), fee = positive(plan.feeBudgetAtomic, 'fee budget');
  requireThat(fee < amount, 'fee budget must leave positive amount');
  if (descriptor.asset === 'XMR') xmrDetails(plan.details);
  else if (descriptor.asset === 'SOL') {
    solDetails(plan.details);
    requireThat(fee >= BigInt(plan.details.priorityFeeBudgetAtomic), 'priority fee exceeds reserved fee budget');
    requireThat(BigInt(plan.details.rentReserveAtomic) + fee <= amount, 'rent and fee exceed model amount budget');
  } else scriptDetails(descriptor.asset, plan.details);
  requireThat(dataHash(plan) === expectedPlanDigest, 'plan differs from independently expected terms');
  return offline({asset: descriptor.asset, descriptorDigest: binding.descriptorDigest, planDigest: expectedPlanDigest,
    verdict: 'STRUCTURE_AND_DIGEST_BOUND_ONLY', nativeQualification: 'NOT TESTED', signatureVerified: false,
    contractSemanticsVerified: false, recoveryVerified: false, chainFactsVerified: false, financialExecutionAllowed: false});
}
export function assessOfflinePair(descriptorA, descriptorB, review) {
  const a = validateOfflineChainDescriptor(descriptorA), b = validateOfflineChainDescriptor(descriptorB); canonical(review);
  exactObject(review, ['schemaVersion', 'descriptorADigest', 'descriptorBDigest', 'protocolReviewDigest', 'recoveryReviewDigest'], 'ordered pair review');
  requireThat(review.schemaVersion === 1 && descriptorA.asset !== descriptorB.asset && review.descriptorADigest === a.descriptorDigest && review.descriptorBDigest === b.descriptorDigest, 'ordered pair identity mismatch');
  digest(review.protocolReviewDigest, 'pair protocol review'); digest(review.recoveryReviewDigest, 'pair recovery review');
  const assets = [descriptorA.asset, descriptorB.asset];
  const requirement = assets.includes('XMR') ? 'SEPARATE_ADAPTOR_PROTOCOL_AND_PAIR_REVIEW_REQUIRED' :
    assets.includes('SOL') ? 'SEPARATE_SWAP_PROGRAM_AND_PAIR_REVIEW_REQUIRED' : 'PAIR_SPECIFIC_SCRIPT_AND_RECOVERY_PROOFS_REQUIRED';
  return offline({direction: assets.join('->'), requirement, orderedReviewDigest: dataHash(review),
    qualifiedDirections: 0, financialExecutionAllowed: false, qualificationStatus: 'BLOCKED',
    missingEvidence: [...new Set(assets.flatMap(asset => GAPS[asset]))]});
}
