export const DATA_PLANE_PROTOCOL_VERSION = 1 as const;

export type DataPlaneTransport =
  | 'DIRECT_QUIC'
  | 'EDGE_QUIC'
  | 'LEGACY_GATEWAY';

export type DataPlaneClientKind = 'BROWSER' | 'NATIVE';

export interface NetworkProbe {
  rttMs: number;
  jitterMs: number;
  packetLossPct: number;
  uploadMbps: number;
  downloadMbps: number;
  tunnelUptimePct: number;
}

export interface EdgeCandidate extends NetworkProbe {
  id: string;
  region: string;
  healthy: boolean;
}

export interface HostConnectivity {
  directQuicReachable: boolean;
  directQuicVerifiedAt: Date | null;
  legacyGatewayHealthy: boolean;
  network: NetworkProbe;
  edges: EdgeCandidate[];
}

export interface ClientCapabilities {
  kind: DataPlaneClientKind;
  quicCapable: boolean;
  webTransportCapable: boolean;
}

export interface DataPlaneFeatureFlags {
  directQuicEnabled: boolean;
  edgeQuicEnabled: boolean;
  legacyFallbackEnabled: boolean;
  browserWebTransportEnabled: boolean;
}

export interface TransportDecision {
  transport: DataPlaneTransport;
  edgeId?: string;
  reason:
    | 'direct_verified'
    | 'edge_best_healthy'
    | 'legacy_fallback';
}

export interface ConnectionQuality {
  score: number;
  eligibleForInteractiveDeveloper: boolean;
  reasons: string[];
}

const DIRECT_VERIFICATION_MAX_AGE_MS = 5 * 60 * 1000;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

export function validateNetworkProbe(probe: NetworkProbe): void {
  const values = [
    probe.rttMs,
    probe.jitterMs,
    probe.packetLossPct,
    probe.uploadMbps,
    probe.downloadMbps,
    probe.tunnelUptimePct,
  ];
  if (!values.every(finite)) throw new Error('network_probe_non_finite');
  if (probe.rttMs < 0 || probe.rttMs > 60_000) throw new Error('network_probe_rtt_invalid');
  if (probe.jitterMs < 0 || probe.jitterMs > 60_000) throw new Error('network_probe_jitter_invalid');
  if (probe.packetLossPct < 0 || probe.packetLossPct > 100) throw new Error('network_probe_loss_invalid');
  if (probe.uploadMbps < 0 || probe.downloadMbps < 0) throw new Error('network_probe_throughput_invalid');
  if (probe.tunnelUptimePct < 0 || probe.tunnelUptimePct > 100) throw new Error('network_probe_uptime_invalid');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function connectionQuality(probe: NetworkProbe): ConnectionQuality {
  validateNetworkProbe(probe);

  // Weighted for an interactive IDE: latency/loss dominate raw throughput.
  const latencyScore = 100 - clamp((probe.rttMs - 20) * 0.75, 0, 100);
  const jitterScore = 100 - clamp(probe.jitterMs * 2.5, 0, 100);
  const lossScore = 100 - clamp(probe.packetLossPct * 25, 0, 100);
  const uploadScore = clamp((probe.uploadMbps / 50) * 100, 0, 100);
  const downloadScore = clamp((probe.downloadMbps / 100) * 100, 0, 100);
  const uptimeScore = clamp((probe.tunnelUptimePct - 95) * 20, 0, 100);

  const score = Math.round(
    latencyScore * 0.30 +
      jitterScore * 0.15 +
      lossScore * 0.25 +
      uploadScore * 0.10 +
      downloadScore * 0.05 +
      uptimeScore * 0.15,
  );

  const reasons: string[] = [];
  if (probe.rttMs > 180) reasons.push('rtt_too_high');
  if (probe.jitterMs > 35) reasons.push('jitter_too_high');
  if (probe.packetLossPct > 1) reasons.push('packet_loss_too_high');
  if (probe.uploadMbps < 10) reasons.push('upload_too_low');
  if (probe.downloadMbps < 25) reasons.push('download_too_low');
  if (probe.tunnelUptimePct < 99) reasons.push('tunnel_uptime_too_low');
  if (score < 70) reasons.push('quality_score_too_low');

  return {
    score,
    eligibleForInteractiveDeveloper: reasons.length === 0,
    reasons,
  };
}

function directVerificationIsFresh(verifiedAt: Date | null, now: Date): boolean {
  if (!verifiedAt) return false;
  const age = now.getTime() - verifiedAt.getTime();
  return age >= 0 && age <= DIRECT_VERIFICATION_MAX_AGE_MS;
}

function edgeRank(edge: EdgeCandidate): number {
  if (!edge.healthy) return Number.POSITIVE_INFINITY;
  const quality = connectionQuality(edge);
  // Prefer RTT first, then penalize loss/jitter. Throughput is already reflected in quality.
  return edge.rttMs + edge.packetLossPct * 100 + edge.jitterMs * 2 - quality.score * 0.1;
}

export function selectDataPlaneTransport(
  host: HostConnectivity,
  client: ClientCapabilities,
  flags: DataPlaneFeatureFlags,
  now = new Date(),
): TransportDecision {
  const hostQuality = connectionQuality(host.network);
  if (!hostQuality.eligibleForInteractiveDeveloper) {
    throw new Error(`host_network_not_interactive:${hostQuality.reasons.join(',')}`);
  }

  const directClientCapable =
    client.kind === 'NATIVE'
      ? client.quicCapable
      : client.webTransportCapable && flags.browserWebTransportEnabled;

  if (
    flags.directQuicEnabled &&
    directClientCapable &&
    host.directQuicReachable &&
    directVerificationIsFresh(host.directQuicVerifiedAt, now)
  ) {
    return { transport: 'DIRECT_QUIC', reason: 'direct_verified' };
  }

  if (flags.edgeQuicEnabled) {
    const bestEdge = host.edges
      .filter((edge) => edge.healthy && connectionQuality(edge).eligibleForInteractiveDeveloper)
      .sort((a, b) => edgeRank(a) - edgeRank(b))[0];
    if (bestEdge) {
      return {
        transport: 'EDGE_QUIC',
        edgeId: bestEdge.id,
        reason: 'edge_best_healthy',
      };
    }
  }

  if (flags.legacyFallbackEnabled && host.legacyGatewayHealthy) {
    return { transport: 'LEGACY_GATEWAY', reason: 'legacy_fallback' };
  }

  throw new Error('data_plane_unavailable');
}
