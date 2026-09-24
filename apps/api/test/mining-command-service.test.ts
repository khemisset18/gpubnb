import assert from 'node:assert/strict';
import test from 'node:test';

import { requestMiningStart } from '../src/mining-command-service.js';

type Candidate = Record<string, unknown>;

const candidate = (overrides: Candidate = {}): Candidate => ({
  resourceId: 'resource_00000001',
  machineId: 'machine_00000001',
  machineModeration: 'CLEAR',
  machineLifecycle: 'ACTIVE',
  kind: 'GPU',
  enabled: true,
  quarantined: false,
  runtimeState: 'STOPPED',
  activeRentalId: null,
  hardwareUuid: 'GPU-aaaaaaaa',
  gpuVendor: 'NVIDIA',
  acceleratorModeration: 'CLEAR',
  acceleratorStatus: 'AVAILABLE',
  configurationId: 'config_00000001',
  mode: 'OWNER_POOL',
  profileId: 'lolminer_etchash',
  walletAddress: 'wallet.example-123',
  workerName: 'worker_1',
  ownerPoolEndpoint: 'stratum+tcp://pool.example.com:4444',
  ownerPoolSecretRef: null,
  maximumTemperatureC: 94,
  maximumPowerWatts: 180,
  configurationVersion: 7,
  ...overrides,
});

class FakeRedis {
  evalCalls = 0;
  lease: Record<string, string> | null = null;
  fence = 0;

  async eval(_script: string, keys: number, ...args: Array<string | number>): Promise<unknown> {
    this.evalCalls += 1;
    if (keys === 2) {
      const holderId = String(args[2]);
      const idempotencyKey = String(args[3]);
      const requestedLeaseId = String(args[4]);
      const ttlMs = Number(args[5]);
      if (this.lease) {
        if (this.lease.holderId === holderId && this.lease.idempotencyKey === idempotencyKey) {
          return [2, this.lease.leaseId, this.lease.fencingToken, ttlMs];
        }
        return [0, this.lease.leaseId, this.lease.fencingToken, ttlMs];
      }
      this.fence += 1;
      this.lease = {
        holderId, idempotencyKey, leaseId: requestedLeaseId, fencingToken: String(this.fence),
      };
      return [1, requestedLeaseId, String(this.fence), ttlMs];
    }
    if (!this.lease) return [0, 'MISSING'];
    this.lease = null;
    return [1, '0'];
  }

  async hgetall(): Promise<Record<string, string>> { return { ...(this.lease ?? {}) }; }
  async pttl(): Promise<number> { return this.lease ? 90_000 : -2; }
}

function sqlText(value: any): string {
  if (Array.isArray(value?.strings)) return value.strings.join('?');
  if (Array.isArray(value?.sql)) return value.sql.join('?');
  return String(value ?? '');
}

function fakeDb(initial: Candidate) {
  const executed: Array<{ text: string; values: unknown[] }> = [];
  let sequence = 40n;
  const tx: any = {
    $queryRaw: async (query: any) => {
      const text = sqlText(query);
      if (text.includes('reserve_machine_sequence')) return [{ sequence: ++sequence }];
      if (text.includes('FROM "MiningResource"')) return [initial];
      return [];
    },
    $executeRaw: async (first: any, ...values: unknown[]) => {
      const text = Array.isArray(first?.raw) ? first.raw.join('?') : sqlText(first);
      const resolvedValues = Array.isArray(first?.values) ? first.values : values;
      executed.push({ text, values: resolvedValues });
      return 1;
    },
  };
  const db: any = {
    $queryRaw: tx.$queryRaw,
    $transaction: async (callback: any) => callback(tx),
  };
  return { db, executed };
}

test('start command is durable, idempotent-shaped and fenced end to end', async () => {
  const redis = new FakeRedis();
  const { db, executed } = fakeDb(candidate());

  const result = await requestMiningStart(db, redis as any, 'machine_00000001', 'resource_00000001');

  assert.equal(result.sequence, 41n);
  assert.equal(result.lease.fencingToken, '1');
  const insert = executed.find((entry) => entry.text.includes('INSERT INTO "MachineCommand"'));
  assert.ok(insert, 'MachineCommand must be inserted');
  const serialized = JSON.stringify(insert?.values);
  assert.match(serialized, /start_mining/);
  assert.match(serialized, /resource_00000001/);
  assert.match(serialized, /GPU-aaaaaaaa/);
  assert.match(serialized, /runtimeGeneration/);
  assert.match(serialized, /fencingToken/);
  assert.match(serialized, /"1"/);
  const state = executed.find((entry) => entry.text.includes('UPDATE "MiningResource"'));
  assert.ok(state, 'resource state must transition to STARTING only with durable command creation');
});

test('rental or other holder lease blocks mining start before command enqueue', async () => {
  const redis = new FakeRedis();
  redis.lease = {
    holderId: 'rental_session_00000001',
    idempotencyKey: 'rental_session_00000001_resource',
    leaseId: 'lease_rental_00000001',
    fencingToken: '9',
  };
  const { db, executed } = fakeDb(candidate());
  await assert.rejects(
    requestMiningStart(db, redis as any, 'machine_00000001', 'resource_00000001'),
    /mining_resource_lease_busy/,
  );
  assert.equal(executed.some((entry) => entry.text.includes('INSERT INTO "MachineCommand"')), false);
});

test('unresolved owner pool secret fails before Redis lease acquisition', async () => {
  const redis = new FakeRedis();
  const { db, executed } = fakeDb(candidate({ ownerPoolSecretRef: 'secret://local/mining/pool-main' }));
  await assert.rejects(
    requestMiningStart(db, redis as any, 'machine_00000001', 'resource_00000001'),
    /miner_secret_resolution_required/,
  );
  assert.equal(redis.evalCalls, 0);
  assert.equal(executed.length, 0);
});

test('non-NVIDIA or moderated machine cannot create a mining command', async () => {
  for (const invalid of [
    { gpuVendor: 'AMD' },
    { machineModeration: 'QUARANTINED' },
    { machineLifecycle: 'STALE' },
    { activeRentalId: 'rental_00000001' },
  ]) {
    const redis = new FakeRedis();
    const { db, executed } = fakeDb(candidate(invalid));
    await assert.rejects(requestMiningStart(db, redis as any, 'machine_00000001', 'resource_00000001'));
    assert.equal(redis.evalCalls, 0);
    assert.equal(executed.length, 0);
  }
});