import { createHash } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,191}$/;
const SAFE_REGION = /^[a-z0-9][a-z0-9-]{1,31}$/;

export const REGIONAL_ROUTING_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_GATEWAY_UTILIZATION_BPS = 9_500;
export const MAX_GATEWAY_ERROR_RATE_BPS = 1_000;

export type RegionalGatewayState = 'READY' | 'DRAINING' | 'DEGRADED' | 'OFFLINE';

export interface RegionalGatewayCandidate {
  gatewayId: string;
  region: string;
  state: RegionalGatewayState;
  observedRttMs: number;
  activeConnections: number;
  maxConnections: number;
  errorRateBps: number;
}

export interface RankedRegionalGateway extends RegionalGatewayCandidate {
  utilizationBps: number;
  score: number;
}

interface RegionalRankingEntry {
  candidate: RankedRegionalGateway;
  regionRank: number;
}

export function rankRegionalGateways(input: {
  machineId: string;
  candidates: readonly RegionalGatewayCandidate[];
  preferredRegions?: readonly string[];
  maxUtilizationBps?: number;
}): RankedRegionalGateway[] {
  validateId(input.machineId, 'regional_routing_machine_id_invalid');
  const maxUtilizationBps = input.maxUtilizationBps ?? DEFAULT_MAX_GATEWAY_UTILIZATION_BPS;
  if (!Number.isSafeInteger(maxUtilizationBps) || maxUtilizationBps < 1_000 || maxUtilizationBps > 9_900) {
    throw new Error('regional_routing_utilization_limit_invalid');
  }
  const preferredRegions = input.preferredRegions ?? [];
  const seenRegions = new Set<string>();
  for (const region of preferredRegions) {
    validateRegion(region);
    if (seenRegions.has(region)) throw new Error('regional_routing_duplicate_preferred_region');
    seenRegions.add(region);
  }

  const ranked: RegionalRankingEntry[] = [];
  for (const rawCandidate of input.candidates) {
    const candidate = validateCandidate(rawCandidate);
    if (candidate.state !== 'READY') continue;

    const utilizationBps = gatewayUtilizationBps(candidate.activeConnections, candidate.maxConnections);
    if (utilizationBps >= maxUtilizationBps || candidate.errorRateBps > MAX_GATEWAY_ERROR_RATE_BPS) continue;

    const preferenceIndex = preferredRegions.indexOf(candidate.region);
    // Region selection is intentionally lexicographic instead of mixing locality
    // into one arbitrary numeric penalty. Once an operator supplies a preferred
    // region order, every admitted gateway in the first healthy region must rank
    // ahead of gateways in later/unlisted regions. Capacity and health gates still
    // override locality before ranking, so a saturated/degraded local region safely
    // falls through to the next region rather than receiving new connections.
    const regionRank = preferredRegions.length === 0
      ? 0
      : preferenceIndex >= 0
        ? preferenceIndex
        : preferredRegions.length;
    const latencyPenalty = candidate.observedRttMs * 1_000;
    const utilizationPenalty = utilizationBps * 20;
    const errorPenalty = candidate.errorRateBps * 100;
    const tieBreaker = stableTieBreaker(input.machineId, candidate.gatewayId);

    ranked.push({
      regionRank,
      candidate: {
        ...candidate,
        utilizationBps,
        score: latencyPenalty + utilizationPenalty + errorPenalty + tieBreaker,
      },
    });
  }

  ranked.sort((left, right) =>
    left.regionRank - right.regionRank
    || left.candidate.score - right.candidate.score
    || left.candidate.gatewayId.localeCompare(right.candidate.gatewayId));
  return ranked.map((entry) => entry.candidate);
}

export function selectRegionalGateway(input: {
  machineId: string;
  candidates: readonly RegionalGatewayCandidate[];
  preferredRegions?: readonly string[];
  maxUtilizationBps?: number;
}): RankedRegionalGateway {
  const ranked = rankRegionalGateways(input);
  const selected = ranked[0];
  if (!selected) throw new Error('no_regional_gateway_capacity');
  return selected;
}

export function gatewayUtilizationBps(activeConnections: number, maxConnections: number): number {
  validateCount(activeConnections, 'regional_routing_active_connections_invalid', 0);
  validateCount(maxConnections, 'regional_routing_max_connections_invalid', 1);
  if (activeConnections > maxConnections) throw new Error('regional_routing_capacity_incoherent');
  return Math.floor((activeConnections * 10_000) / maxConnections);
}

function validateCandidate(candidate: RegionalGatewayCandidate): RegionalGatewayCandidate {
  validateId(candidate.gatewayId, 'regional_routing_gateway_id_invalid');
  validateRegion(candidate.region);
  if (!['READY', 'DRAINING', 'DEGRADED', 'OFFLINE'].includes(candidate.state)) {
    throw new Error('regional_routing_gateway_state_invalid');
  }
  if (!Number.isFinite(candidate.observedRttMs) || candidate.observedRttMs < 0 || candidate.observedRttMs > 60_000) {
    throw new Error('regional_routing_rtt_invalid');
  }
  validateCount(candidate.activeConnections, 'regional_routing_active_connections_invalid', 0);
  validateCount(candidate.maxConnections, 'regional_routing_max_connections_invalid', 1);
  if (candidate.activeConnections > candidate.maxConnections) throw new Error('regional_routing_capacity_incoherent');
  if (!Number.isSafeInteger(candidate.errorRateBps) || candidate.errorRateBps < 0 || candidate.errorRateBps > 10_000) {
    throw new Error('regional_routing_error_rate_invalid');
  }
  return candidate;
}

function stableTieBreaker(machineId: string, gatewayId: string): number {
  const digest = createHash('sha256').update(`${machineId}\0${gatewayId}`, 'utf8').digest();
  return digest.readUInt16BE(0);
}

function validateCount(value: number, error: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 100_000_000) throw new Error(error);
}

function validateId(value: string, error: string): void {
  if (!SAFE_ID.test(value)) throw new Error(error);
}

function validateRegion(value: string): void {
  if (!SAFE_REGION.test(value)) throw new Error('regional_routing_region_invalid');
}
