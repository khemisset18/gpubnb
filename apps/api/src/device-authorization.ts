import crypto from 'node:crypto';

export const DEVICE_AUTHORIZATION_TTL_SECONDS = 10 * 60;
export const DEVICE_AUTHORIZATION_POLL_INTERVAL_SECONDS = 5;

const DEVICE_CODE_BYTES = 32;
const USER_CODE_BYTES = 5;
const PUBLIC_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const FINGERPRINT_PATTERN = /^[A-Fa-f0-9]{64}$/;

export type DeviceAuthorizationStatus = 'pending' | 'authorized' | 'consumed';

export type DeviceAuthorizationRecord = {
  deviceCodeDigest: string;
  userCodeDigest: string;
  publicKey: string;
  machineFingerprint: string;
  createdAtUnix: number;
  expiresAtUnix: number;
  status: DeviceAuthorizationStatus;
  ownerId?: string;
  authorizedAtUnix?: number;
  consumedAtUnix?: number;
};

export type DeviceAuthorizationChallenge = {
  deviceCode: string;
  userCode: string;
  verificationPath: string;
  expiresIn: number;
  interval: number;
  record: DeviceAuthorizationRecord;
};

export type DeviceAuthorizationConsumption = {
  ownerId: string;
  publicKey: string;
  machineFingerprint: string;
  authorizedAtUnix: number;
};

export class DeviceAuthorizationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_public_key'
      | 'invalid_machine_fingerprint'
      | 'authorization_not_found'
      | 'authorization_expired'
      | 'authorization_pending'
      | 'authorization_already_authorized'
      | 'authorization_already_consumed'
      | 'device_identity_mismatch',
  ) {
    super(code);
    this.name = 'DeviceAuthorizationError';
  }
}

export const digestDeviceAuthorizationSecret = (value: string): string =>
  crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const createOpaqueSecret = (bytes: number): string => crypto.randomBytes(bytes).toString('base64url');

const createUserCode = (): string => crypto.randomBytes(USER_CODE_BYTES).toString('hex').toUpperCase();

export const createDeviceAuthorization = (
  input: { publicKey: string; machineFingerprint: string },
  nowUnix = Math.floor(Date.now() / 1000),
): DeviceAuthorizationChallenge => {
  if (!PUBLIC_KEY_PATTERN.test(input.publicKey)) {
    throw new DeviceAuthorizationError('invalid_public_key');
  }
  if (!FINGERPRINT_PATTERN.test(input.machineFingerprint)) {
    throw new DeviceAuthorizationError('invalid_machine_fingerprint');
  }

  const deviceCode = createOpaqueSecret(DEVICE_CODE_BYTES);
  const userCode = createUserCode();
  const expiresAtUnix = nowUnix + DEVICE_AUTHORIZATION_TTL_SECONDS;

  return {
    deviceCode,
    userCode,
    verificationPath: `/host/authorize?code=${encodeURIComponent(userCode)}`,
    expiresIn: DEVICE_AUTHORIZATION_TTL_SECONDS,
    interval: DEVICE_AUTHORIZATION_POLL_INTERVAL_SECONDS,
    record: {
      deviceCodeDigest: digestDeviceAuthorizationSecret(deviceCode),
      userCodeDigest: digestDeviceAuthorizationSecret(userCode),
      publicKey: input.publicKey,
      machineFingerprint: input.machineFingerprint.toLowerCase(),
      createdAtUnix: nowUnix,
      expiresAtUnix,
      status: 'pending',
    },
  };
};

const assertNotExpired = (record: DeviceAuthorizationRecord, nowUnix: number): void => {
  if (nowUnix >= record.expiresAtUnix) {
    throw new DeviceAuthorizationError('authorization_expired');
  }
};

export const authorizeDevice = (
  record: DeviceAuthorizationRecord | null,
  ownerId: string,
  nowUnix = Math.floor(Date.now() / 1000),
): DeviceAuthorizationRecord => {
  if (!record) throw new DeviceAuthorizationError('authorization_not_found');
  assertNotExpired(record, nowUnix);
  if (record.status === 'consumed') {
    throw new DeviceAuthorizationError('authorization_already_consumed');
  }
  if (record.status === 'authorized') {
    throw new DeviceAuthorizationError('authorization_already_authorized');
  }

  return {
    ...record,
    status: 'authorized',
    ownerId,
    authorizedAtUnix: nowUnix,
  };
};

export const consumeDeviceAuthorization = (
  record: DeviceAuthorizationRecord | null,
  nowUnix = Math.floor(Date.now() / 1000),
): { record: DeviceAuthorizationRecord; result: DeviceAuthorizationConsumption } => {
  if (!record) throw new DeviceAuthorizationError('authorization_not_found');
  assertNotExpired(record, nowUnix);
  if (record.status === 'pending') {
    throw new DeviceAuthorizationError('authorization_pending');
  }
  if (record.status === 'consumed') {
    throw new DeviceAuthorizationError('authorization_already_consumed');
  }
  if (!record.ownerId || record.authorizedAtUnix === undefined) {
    throw new DeviceAuthorizationError('authorization_pending');
  }

  return {
    record: {
      ...record,
      status: 'consumed',
      consumedAtUnix: nowUnix,
    },
    result: {
      ownerId: record.ownerId,
      publicKey: record.publicKey,
      machineFingerprint: record.machineFingerprint,
      authorizedAtUnix: record.authorizedAtUnix,
    },
  };
};
