export type MiningProfileResourceKind = 'CPU' | 'GPU';
export type MiningGpuVendor = 'NVIDIA' | 'AMD';

export type MiningProfileDefinition = {
  id: string;
  resourceKind: MiningProfileResourceKind;
  cryptocurrency: string;
  algorithm: string;
  miner: string;
  enabled: boolean;
  gpuVendors?: readonly MiningGpuVendor[];
};

// Server-side allowlist. Keep identifiers aligned with the approved desktop
// runtime profiles. Unknown, disabled, or hardware-incompatible profiles must
// never reach execution.
export const MINING_PROFILE_CATALOG: readonly MiningProfileDefinition[] = [
  {
    id: 'trex_rvn_kawpow',
    resourceKind: 'GPU',
    cryptocurrency: 'RVN',
    algorithm: 'kawpow',
    miner: 't-rex',
    enabled: true,
    gpuVendors: ['NVIDIA'],
  },
  {
    id: 'teamredminer_rvn_kawpow',
    resourceKind: 'GPU',
    cryptocurrency: 'RVN',
    algorithm: 'kawpow',
    miner: 'teamredminer',
    enabled: true,
    gpuVendors: ['AMD'],
  },
  {
    id: 'lolminer_etc_etchash',
    resourceKind: 'GPU',
    cryptocurrency: 'ETC',
    algorithm: 'etchash',
    miner: 'lolminer',
    enabled: true,
    gpuVendors: ['AMD', 'NVIDIA'],
  },
  {
    id: 'lolminer_erg_autolykos2',
    resourceKind: 'GPU',
    cryptocurrency: 'ERG',
    algorithm: 'autolykos2',
    miner: 'lolminer',
    enabled: true,
    gpuVendors: ['AMD', 'NVIDIA'],
  },
  {
    id: 'lolminer_flux_zelhash',
    resourceKind: 'GPU',
    cryptocurrency: 'FLUX',
    algorithm: 'zelhash',
    miner: 'lolminer',
    enabled: true,
    gpuVendors: ['AMD', 'NVIDIA'],
  },
  {
    id: 'lolminer_beam_beamhashiii',
    resourceKind: 'GPU',
    cryptocurrency: 'BEAM',
    algorithm: 'beamhashiii',
    miner: 'lolminer',
    enabled: false,
    gpuVendors: ['AMD', 'NVIDIA'],
  },
  {
    id: 'lolminer_ctxc_cuckatoo32',
    resourceKind: 'GPU',
    cryptocurrency: 'CTXC',
    algorithm: 'cuckatoo32',
    miner: 'lolminer',
    enabled: false,
    gpuVendors: ['AMD', 'NVIDIA'],
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

export function normalizeMiningGpuVendor(value: string | null | undefined): MiningGpuVendor | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized.includes('NVIDIA')) return 'NVIDIA';
  if (normalized === 'AMD' || normalized.includes('ADVANCED MICRO DEVICES')) return 'AMD';
  return undefined;
}

export function isMiningProfileApproved(
  profileId: string,
  resourceKind: MiningProfileResourceKind,
  gpuVendor?: MiningGpuVendor,
): boolean {
  const profile = miningProfileById(profileId);
  if (!profile?.enabled || profile.resourceKind !== resourceKind) return false;
  if (resourceKind === 'CPU') return true;
  return Boolean(gpuVendor && profile.gpuVendors?.includes(gpuVendor));
}
