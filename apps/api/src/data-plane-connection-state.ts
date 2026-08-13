import type { DataPlaneStreamKind, DataPlaneTransport } from './data-plane-protocol.js';

export type DataPlaneConnectionPhase =
  | 'ALLOCATED'
  | 'SERVICE_READY'
  | 'TUNNEL_READY'
  | 'MANAGEMENT_READY'
  | 'EXTENSION_HOST_READY'
  | 'INTERACTIVE'
  | 'DEGRADED'
  | 'CLOSED';

export interface DataPlaneConnectionSnapshot {
  phase: DataPlaneConnectionPhase;
  transport: DataPlaneTransport;
  allocatedAtMs: number;
  serviceReadyAtMs?: number;
  tunnelReadyAtMs?: number;
  managementReadyAtMs?: number;
  extensionHostReadyAtMs?: number;
  interactiveAtMs?: number;
  degradedAtMs?: number;
  closedAtMs?: number;
  activeStreams: ReadonlySet<DataPlaneStreamKind>;
  reconnects: number;
  fallbacks: number;
}

function safeTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('data_plane_event_time_invalid');
}

function ensureNotTerminal(snapshot: DataPlaneConnectionSnapshot): void {
  if (snapshot.phase === 'CLOSED') throw new Error('data_plane_connection_closed');
}

function copy(snapshot: DataPlaneConnectionSnapshot): DataPlaneConnectionSnapshot {
  return { ...snapshot, activeStreams: new Set(snapshot.activeStreams) };
}

export function createDataPlaneConnection(
  transport: DataPlaneTransport,
  allocatedAtMs: number,
): DataPlaneConnectionSnapshot {
  safeTime(allocatedAtMs);
  return {
    phase: 'ALLOCATED',
    transport,
    allocatedAtMs,
    activeStreams: new Set(),
    reconnects: 0,
    fallbacks: 0,
  };
}

export function markServiceReady(
  current: DataPlaneConnectionSnapshot,
  atMs: number,
): DataPlaneConnectionSnapshot {
  safeTime(atMs);
  ensureNotTerminal(current);
  if (atMs < current.allocatedAtMs) throw new Error('data_plane_event_time_regression');
  if (current.serviceReadyAtMs !== undefined) return current;
  return { ...copy(current), phase: 'SERVICE_READY', serviceReadyAtMs: atMs };
}

export function markTunnelReady(
  current: DataPlaneConnectionSnapshot,
  atMs: number,
): DataPlaneConnectionSnapshot {
  safeTime(atMs);
  ensureNotTerminal(current);
  if (current.serviceReadyAtMs === undefined) throw new Error('data_plane_service_not_ready');
  if (atMs < current.serviceReadyAtMs) throw new Error('data_plane_event_time_regression');
  if (current.tunnelReadyAtMs !== undefined) return current;
  return { ...copy(current), phase: 'TUNNEL_READY', tunnelReadyAtMs: atMs };
}

function phaseForStreams(streams: ReadonlySet<DataPlaneStreamKind>): DataPlaneConnectionPhase {
  const management = streams.has('VSCODE_MANAGEMENT');
  const extensionHost = streams.has('VSCODE_EXTENSION_HOST');
  if (management && extensionHost) return 'INTERACTIVE';
  if (management) return 'MANAGEMENT_READY';
  if (extensionHost) return 'EXTENSION_HOST_READY';
  return 'TUNNEL_READY';
}

export function markStreamReady(
  current: DataPlaneConnectionSnapshot,
  kind: DataPlaneStreamKind,
  atMs: number,
): DataPlaneConnectionSnapshot {
  safeTime(atMs);
  ensureNotTerminal(current);
  if (current.tunnelReadyAtMs === undefined) throw new Error('data_plane_tunnel_not_ready');
  if (atMs < current.tunnelReadyAtMs) throw new Error('data_plane_event_time_regression');

  const next = copy(current);
  (next.activeStreams as Set<DataPlaneStreamKind>).add(kind);
  if (kind === 'VSCODE_MANAGEMENT' && next.managementReadyAtMs === undefined) next.managementReadyAtMs = atMs;
  if (kind === 'VSCODE_EXTENSION_HOST' && next.extensionHostReadyAtMs === undefined) next.extensionHostReadyAtMs = atMs;

  const computed = phaseForStreams(next.activeStreams);
  if (computed === 'INTERACTIVE') {
    next.phase = 'INTERACTIVE';
    next.interactiveAtMs ??= Math.max(next.managementReadyAtMs!, next.extensionHostReadyAtMs!);
  } else if (next.phase !== 'INTERACTIVE') {
    next.phase = computed;
  }
  return next;
}

export function markStreamClosed(
  current: DataPlaneConnectionSnapshot,
  kind: DataPlaneStreamKind,
  atMs: number,
): DataPlaneConnectionSnapshot {
  safeTime(atMs);
  ensureNotTerminal(current);
  const next = copy(current);
  (next.activeStreams as Set<DataPlaneStreamKind>).delete(kind);

  if (
    current.phase === 'INTERACTIVE' &&
    (kind === 'VSCODE_MANAGEMENT' || kind === 'VSCODE_EXTENSION_HOST')
  ) {
    next.phase = 'DEGRADED';
    next.degradedAtMs ??= atMs;
  }
  return next;
}

export function recordReconnect(
  current: DataPlaneConnectionSnapshot,
): DataPlaneConnectionSnapshot {
  ensureNotTerminal(current);
  if (current.reconnects >= 1_000_000) throw new Error('data_plane_reconnect_counter_exhausted');
  return { ...copy(current), reconnects: current.reconnects + 1 };
}

export function recordFallback(
  current: DataPlaneConnectionSnapshot,
  transport: DataPlaneTransport,
): DataPlaneConnectionSnapshot {
  ensureNotTerminal(current);
  if (transport === current.transport) throw new Error('data_plane_fallback_same_transport');
  if (current.fallbacks >= 1000) throw new Error('data_plane_fallback_counter_exhausted');
  return { ...copy(current), transport, fallbacks: current.fallbacks + 1 };
}

export function closeDataPlaneConnection(
  current: DataPlaneConnectionSnapshot,
  atMs: number,
): DataPlaneConnectionSnapshot {
  safeTime(atMs);
  if (current.phase === 'CLOSED') return current;
  if (atMs < current.allocatedAtMs) throw new Error('data_plane_event_time_regression');
  return {
    ...copy(current),
    phase: 'CLOSED',
    closedAtMs: atMs,
    activeStreams: new Set(),
  };
}

export function interactiveLatencyMs(snapshot: DataPlaneConnectionSnapshot): number | null {
  if (snapshot.interactiveAtMs === undefined || snapshot.serviceReadyAtMs === undefined) return null;
  return snapshot.interactiveAtMs - snapshot.serviceReadyAtMs;
}
