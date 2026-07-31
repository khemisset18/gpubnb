export type MiningProfileResourceKind = 'CPU' | 'GPU';

export type MiningProfileDefinition = {
  id: string;
  resourceKind: MiningProfileResourceKind;
  cryptocurrency: string;
  algorithm: string;
  miner: string;
  enabled: boolean;
};

// Server-side allowlist. Keep identifiers aligned with the approved desktop
// runtime profiles. Unknown or disabled profiles must never reach execution.
export const MINING_PROFILE_CATALOG: readonly MiningProfileDefinition[] = [
  {
    id: 'trex_rvn_kawpow',
    resourceKind: 'GPU',
    cryptocurrency: 'RVN',
    algorithm: 'kawpow',
    miner: 't-rex',
    enabled: true,
  },
  {
    id: 'teamredminer_rvn_kawpow',
    resourceKind: 'GPU',
    cryptocurrency: 'RVN',
    algorithm: 'kawpow',
    miner: 'teamredminer',
    enabled: true,
  },
  {
    id: 'lolminer_etc_etchash',
    resourceKind: 'GPU',
    cryptocurrency: 'ETC',
    algorithm: 'etchash',
    miner: 'lolminer',
    enabled: true,
  },
  {
    id: 'lolminer_erg_autolykos2',
    resourceKind: 'GPU',
    cryptocurrency: 'ERG',
    algorithm: 'autolykos2',
    miner: 'lolminer',
    enabled: true,
  },
  {
    id: 'lolminer_flux_zelhash',
    resourceKind: 'GPU',
    cryptocurrency: 'FLUX',
    algorithm: 'zelhash',
    miner: 'lolminer',
    enabled: true,
  },
  {
    id: 'lolminer_beam_beamhashiii',
    resourceKind: 'GPU',
    cryptocurrency: 'BEAM',
    algorithm: 'beamhashiii',
    miner: 'lolminer',
    enabled: false,
  },
  {
    id: 'lolminer_ctxc_cuckatoo32',
    resourceKind: 'GPU',
    cryptocurrency: 'CTXC',
    algorithm: 'cuckatoo32',
    miner: 'lolminer',
    enabled: false,
  },
  {
    id: 'xmrig_randomx',
    resourceKind: 'CPU',
    cryptocurrency: 'XMR',
    algorithm: 'randomx',
    miner: 'xmrig',
    enabled: true,
  },
] as const;

export function miningProfileById(profileId: string): MiningProfileDefinition | undefined {
  return MINING_PROFILE_CATALOG.find((profile) => profile.id === profileId);
}

export function isMiningProfileApproved(
  profileId: string,
  resourceKind: MiningProfileResourceKind,
): boolean {
  const profile = miningProfileById(profileId);
  return Boolean(profile?.enabled && profile.resourceKind === resourceKind);
}
