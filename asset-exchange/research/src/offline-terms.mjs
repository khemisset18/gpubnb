// Offline terms binding. Caller-supplied pinned profiles are assumptions, not chain certification.
import {exactObject, requireThat, text, uint, safeTime, digest, dataHash, offline} from './offline-data.mjs';
const ASSETS = ['BTC', 'DOGE', 'LTC', 'BCH', 'XMR'];
const MAXIMUM = (1n << 64n) - 1n;
function leg(value, profiles) {
  exactObject(value, ['asset', 'network', 'genesis', 'profileDigest', 'amountAtomic', 'feeReserveAtomic', 'refundDestination'], 'leg');
  requireThat(ASSETS.includes(value.asset), 'unknown asset');
  const profile = profiles.find(p => p.asset === value.asset && p.network === value.network);
  requireThat(profile && profile.genesis === value.genesis && dataHash(profile) === value.profileDigest, 'network/genesis/profile binding mismatch');
  const amount = uint(value.amountAtomic, 'amount', MAXIMUM), reserve = uint(value.feeReserveAtomic, 'fee reserve', MAXIMUM);
  requireThat(amount > 0n && amount + reserve <= uint(profile.maximumAtomic, 'profile maximum', MAXIMUM), 'invalid amount or reserve');
  // An opaque commitment, not an address validator. Actual chain address validation remains NOT TESTED.
  digest(value.refundDestination, 'refund destination commitment');
}
export function validateOfflineTerms(terms, manifest, expectedManifestDigest, now) {
  safeTime(now, 'now'); digest(expectedManifestDigest, 'pinned profile manifest');
  exactObject(manifest, ['schemaVersion', 'simulationOnly', 'qualified', 'profiles'], 'manifest');
  requireThat(manifest.schemaVersion === 1 && manifest.simulationOnly === true && manifest.qualified === false, 'research profile boundary');
  requireThat(dataHash(manifest) === expectedManifestDigest, 'profile manifest digest mismatch');
  requireThat(Array.isArray(manifest.profiles) && manifest.profiles.length === 5, 'exactly five research profiles required');
  const seen = new Set();
  for (const p of manifest.profiles) {
    exactObject(p, ['asset', 'network', 'genesis', 'decimals', 'maximumAtomic', 'profileVersion'], 'profile');
    requireThat(ASSETS.includes(p.asset) && !seen.has(p.asset), 'duplicate or unknown profile'); seen.add(p.asset);
    requireThat(p.network === 'synthetic-offline' && p.profileVersion === 1, 'only synthetic offline profiles allowed');
    digest(p.genesis, 'synthetic genesis'); requireThat(Number.isSafeInteger(p.decimals) && p.decimals === (p.asset === 'XMR' ? 12 : 8), 'asset decimals mismatch');
    requireThat(uint(p.maximumAtomic, 'profile maximum', MAXIMUM) > 0n, 'positive profile maximum required');
  }
  exactObject(terms, ['schemaVersion', 'tradeId', 'manifestDigest', 'legA', 'legB', 'createdAt', 'expiresAt', 'route'], 'terms');
  requireThat(terms.schemaVersion === 1 && terms.manifestDigest === expectedManifestDigest, 'terms/profile version mismatch');
  text(terms.tradeId, /^[A-Za-z0-9:-]{8,128}$/, 'trade identity');
  safeTime(terms.createdAt, 'createdAt'); safeTime(terms.expiresAt, 'expiresAt');
  requireThat(terms.createdAt <= now && terms.expiresAt > now && terms.expiresAt - terms.createdAt <= 86400, 'future, stale or unbounded terms');
  leg(terms.legA, manifest.profiles); leg(terms.legB, manifest.profiles);
  requireThat(terms.legA.asset !== terms.legB.asset, 'same-asset pair');
  const unavailable = [terms.legA.asset, terms.legB.asset].includes('DOGE') && [terms.legA.asset, terms.legB.asset].includes('XMR');
  requireThat(terms.route === (unavailable ? 'NO_REVIEWED_ROUTE' : 'RESEARCH_ONLY'), 'unsupported route promotion');
  return offline({termsDigest: dataHash(terms), manifestDigest: expectedManifestDigest,
    direction: `${terms.legA.asset}->${terms.legB.asset}`, route: terms.route, admissibleForExecution: false,
    status: unavailable ? 'BLOCKED_NO_REVIEWED_ROUTE' : 'OFFLINE_TERMS_BOUND'});
}
