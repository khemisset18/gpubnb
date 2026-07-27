import type { Redis } from 'ioredis';

import {
  DEVICE_AUTHORIZATION_TTL_SECONDS,
  DeviceAuthorizationError,
  type DeviceAuthorizationRecord,
  authorizeDevice,
  consumeDeviceAuthorization,
  digestDeviceAuthorizationSecret,
} from './device-authorization.js';

const DEVICE_PREFIX = 'device-auth:device:';
const USER_PREFIX = 'device-auth:user:';

const parseRecord = (raw: string | null): DeviceAuthorizationRecord | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeviceAuthorizationRecord;
  } catch {
    throw new DeviceAuthorizationError('authorization_not_found');
  }
};

export class RedisDeviceAuthorizationStore {
  constructor(private readonly redis: Redis) {}

  async create(record: DeviceAuthorizationRecord): Promise<void> {
    const deviceKey = `${DEVICE_PREFIX}${record.deviceCodeDigest}`;
    const userKey = `${USER_PREFIX}${record.userCodeDigest}`;
    const payload = JSON.stringify(record);

    const created = await this.redis.eval(
      `
      if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then
        return 0
      end
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
      redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
      return 1
      `,
      2,
      deviceKey,
      userKey,
      payload,
      String(DEVICE_AUTHORIZATION_TTL_SECONDS),
      record.deviceCodeDigest,
    );

    if (Number(created) !== 1) {
      throw new Error('device_authorization_collision');
    }
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceAuthorizationRecord | null> {
    return parseRecord(await this.redis.get(`${DEVICE_PREFIX}${digestDeviceAuthorizationSecret(deviceCode)}`));
  }

  async findByUserCode(userCode: string): Promise<DeviceAuthorizationRecord | null> {
    const deviceDigest = await this.redis.get(`${USER_PREFIX}${digestDeviceAuthorizationSecret(userCode)}`);
    if (!deviceDigest) return null;
    return parseRecord(await this.redis.get(`${DEVICE_PREFIX}${deviceDigest}`));
  }

  async authorize(userCode: string, ownerId: string, nowUnix = Math.floor(Date.now() / 1000)): Promise<DeviceAuthorizationRecord> {
    const userKey = `${USER_PREFIX}${digestDeviceAuthorizationSecret(userCode)}`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.redis.watch(userKey);
      const deviceDigest = await this.redis.get(userKey);
      if (!deviceDigest) {
        await this.redis.unwatch();
        throw new DeviceAuthorizationError('authorization_not_found');
      }

      const deviceKey = `${DEVICE_PREFIX}${deviceDigest}`;
      await this.redis.watch(deviceKey);
      const current = parseRecord(await this.redis.get(deviceKey));
      const updated = authorizeDevice(current, ownerId, nowUnix);
      const remainingTtl = Math.max(1, updated.expiresAtUnix - nowUnix);
      const result = await this.redis.multi().set(deviceKey, JSON.stringify(updated), 'EX', remainingTtl).exec();
      if (result) return updated;
    }

    throw new Error('device_authorization_concurrent_update');
  }

  async consume(deviceCode: string, nowUnix = Math.floor(Date.now() / 1000)) {
    const deviceKey = `${DEVICE_PREFIX}${digestDeviceAuthorizationSecret(deviceCode)}`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.redis.watch(deviceKey);
      const current = parseRecord(await this.redis.get(deviceKey));
      const consumed = consumeDeviceAuthorization(current, nowUnix);
      const remainingTtl = Math.max(1, consumed.record.expiresAtUnix - nowUnix);
      const result = await this.redis
        .multi()
        .set(deviceKey, JSON.stringify(consumed.record), 'EX', remainingTtl)
        .del(`${USER_PREFIX}${consumed.record.userCodeDigest}`)
        .exec();
      if (result) return consumed.result;
    }

    throw new Error('device_authorization_concurrent_update');
  }
}
