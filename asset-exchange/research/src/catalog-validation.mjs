// Research artifact validation only. Never grants a chain/settlement capability.
const fail = (condition, message) => { if (!condition) throw new Error(message); };
const assets = ['BTC', 'DOGE', 'LTC', 'BCH', 'XMR'];
export function validateResearchCatalog(catalog, probe) {
  fail(catalog?.notAnActivationManifest === true, 'research cannot activate assets');
  fail(catalog.sourceCommits?.basicswap === probe?.commit, 'probe/source commit mismatch');
  fail(Array.isArray(catalog.directions) && catalog.directions.length === 20, 'twenty directions required');
  const seen = new Set(), fields = ['claim', 'refund', 'expiration', 'signatureProfiles', 'walletProfiles', 'rpcProfiles', 'feeLimits', 'confirmations', 'reorgRisk', 'availability', 'limitations', 'upstreamTests', 'missingGpuBnbTests'];
  for (const row of catalog.directions) {
    const [from, to] = row.direction.split(' → ');
    fail(assets.includes(from) && assets.includes(to) && from !== to && !seen.has(row.direction), 'invalid/duplicate pair direction'); seen.add(row.direction);
    fail(fields.every(key => Object.hasOwn(row, key) && row[key] != null && row[key].length > 0), 'incomplete pair evidence');
    const evidence = probe.results.find(p => p.from === from && p.to === to);
    fail(Boolean(evidence), 'missing source routing observation');
    if (evidence.result !== 'ADMITTED_BY_TYPE_VALIDATOR_ONLY') fail(row.basicswap?.status === 'Support incompatible ou non démontré', 'rejected pair cannot be promoted by asset-list inference');
    if ([from, to].includes('XMR')) fail(['Implémentation partielle', 'Implémentation absente', 'Support incompatible ou non démontré'].includes(row.dcrdex?.status), 'wallet stub is not implemented XMR trading');
    fail(row.gpuBnbStatus?.startsWith('PRÉPARÉ SANS EXÉCUTION'), 'research is not a qualification');
  }
  return {validatedCatalogStructureOnly: true, uniquePairs: 10, directions: seen.size, qualified: false};
}
