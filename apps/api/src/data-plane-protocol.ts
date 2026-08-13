export const GPUBNB_DATA_PLANE_ALPN = 'gpubnb-dp/1';
export const GPUBNB_DATA_PLANE_VERSION = 1 as const;

export const DATA_PLANE_LIMITS = Object.freeze({
  maxStreamsPerSession: 64,
  maxControlMessageBytes: 64 * 1024,
  maxStreamOpenMetadataBytes: 8 * 1024,
  maxReconnectWindowMs: 30_000,
  maxResumeGap: 4_096,
  maxSessionLifetimeMs: 24 * 60 * 60 * 1000,
});

export type DataPlaneStreamKind =
  | 'CONTROL'
  | 'VSCODE_MANAGEMENT'
  | 'VSCODE_EXTENSION_HOST'
  | 'TERMINAL'
  | 'FILE_TRANSFER'
  | 'JUPYTER'
  | 'APP_PORT';

export interface DataPlaneSessionBinding {
  protocolVersion: typeof GPUBNB_DATA_PLANE_VERSION;
  sessionId: string;
  machineId: string;
  bookingId: string;
  renterUserId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  nonce: string;
}

export interface DataPlaneOpenStream {
  type: 'OPEN_STREAM';
  streamId: number;
  kind: DataPlaneStreamKind;
  targetPort?: number;
  resumeFromSequence?: number;
}

export interface DataPlaneStreamAccepted {
  type: 'STREAM_ACCEPTED';
  streamId: number;
  initialSequence: number;
}

export interface DataPlaneStreamRejected {
  type: 'STREAM_REJECTED';
  streamId: number;
  code:
    | 'UNAUTHORIZED'
    | 'SESSION_EXPIRED'
    | 'STREAM_LIMIT'
    | 'INVALID_TARGET'
    | 'UNSUPPORTED_KIND'
    | 'RESUME_WINDOW_EXPIRED';
}

export interface DataPlaneHeartbeat {
  type: 'HEARTBEAT';
  monotonicMs: number;
  activeStreams: number;
}

export type DataPlaneControlMessage =
  | DataPlaneOpenStream
  | DataPlaneStreamAccepted
  | DataPlaneStreamRejected
  | DataPlaneHeartbeat;

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_NONCE = /^[A-Fa-f0-9]{32,128}$/;

export function validateSessionBinding(binding: DataPlaneSessionBinding, nowMs: number): void {
  if (binding.protocolVersion !== GPUBNB_DATA_PLANE_VERSION) throw new Error('data_plane_version_mismatch');
  for (const [name, value] of [
    ['sessionId', binding.sessionId],
    ['machineId', binding.machineId],
    ['bookingId', binding.bookingId],
    ['renterUserId', binding.renterUserId],
  ] as const) {
    if (!SAFE_ID.test(value)) throw new Error(`data_plane_binding_${name}_invalid`);
  }
  if (!SAFE_NONCE.test(binding.nonce)) throw new Error('data_plane_binding_nonce_invalid');
  if (!Number.isSafeInteger(binding.issuedAtMs) || !Number.isSafeInteger(binding.expiresAtMs)) {
    throw new Error('data_plane_binding_time_invalid');
  }
  if (binding.expiresAtMs <= binding.issuedAtMs) throw new Error('data_plane_binding_expiry_invalid');
  if (binding.expiresAtMs - binding.issuedAtMs > DATA_PLANE_LIMITS.maxSessionLifetimeMs) {
    throw new Error('data_plane_binding_lifetime_invalid');
  }
  if (nowMs < binding.issuedAtMs - 30_000 || nowMs >= binding.expiresAtMs) {
    throw new Error('data_plane_binding_not_current');
  }
}

export function validateOpenStream(message: DataPlaneOpenStream): void {
  if (!Number.isSafeInteger(message.streamId) || message.streamId < 1 || message.streamId > 0x7fffffff) {
    throw new Error('data_plane_stream_id_invalid');
  }

  const validKinds: ReadonlySet<DataPlaneStreamKind> = new Set([
    'CONTROL',
    'VSCODE_MANAGEMENT',
    'VSCODE_EXTENSION_HOST',
    'TERMINAL',
    'FILE_TRANSFER',
    'JUPYTER',
    'APP_PORT',
  ]);
  if (!validKinds.has(message.kind)) throw new Error('data_plane_stream_kind_invalid');

  if (message.kind === 'APP_PORT') {
    if (!Number.isInteger(message.targetPort) || message.targetPort! < 1 || message.targetPort! > 65535) {
      throw new Error('data_plane_target_port_invalid');
    }
  } else if (message.targetPort !== undefined) {
    throw new Error('data_plane_target_port_forbidden');
  }

  if (message.resumeFromSequence !== undefined) {
    if (!Number.isSafeInteger(message.resumeFromSequence) || message.resumeFromSequence < 0) {
      throw new Error('data_plane_resume_sequence_invalid');
    }
  }
}

export function isInteractiveReady(activeKinds: Iterable<DataPlaneStreamKind>): boolean {
  const kinds = new Set(activeKinds);
  return kinds.has('VSCODE_MANAGEMENT') && kinds.has('VSCODE_EXTENSION_HOST');
}
