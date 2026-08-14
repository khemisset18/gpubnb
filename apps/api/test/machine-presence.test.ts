import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimMachinePresence,
  machinePresenceKey,
  readMachinePresence,
  releaseMachinePresence,
  touchMachinePresence,
  type MachinePresenceRedis,
} from '../src/machine-presence.js';

class FakePresenceRedis implements MachinePresenceRedis {
  private readonly fields = new Map<string, Record<string, string>>();
  private readonly ttl = new Map<string, number>();

  async eval(_script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    assert.equal(numberOfKeys, 1);
    const key = String(args[0]);
    if (args.length === 7) {
      this.fields.set(key, {
        connectionId: String(args[1]),
        gatewayId: String(args[2]),
        region: String(args[3]),
        sequence: '-1',
        phase: String(args[4]),
        lastSeenAtMs: String(args[5]),
      });
      this.ttl.set(key, Number(args[6]));
      return 1;
    }
    if (args.length === 6) {
      const current = this.fields.get(key);
      if (!current) return [0, 'MISSING', ''];
      if (current.connectionId !== String(args[1])) return [0, 'STALE_CONNECTION', current.sequence ?? ''];
      const sequence = Number(args[2]);
      const currentSequence = Number(current.sequence ?? '-1');
      if (sequence <= currentSequence) return [0, 'STALE_SEQUENCE', String(currentSequence)];
      current.sequence = String(sequence);
      current.phase = String(args[3]);
      current.lastSeenAtMs = String(args[4]);
      this.ttl.set(key, Number(args[5]));
      return [1, 'OK', String(sequence)];
    }
    if (args.length === 2) {
      const current = this.fields.get(key);
      if (!current || current.connectionId !== String(args[1])) return 0;
      this.fields.delete(key);
      this.ttl.delete(key);
      return 1;
    }
    throw new Error('unexpected_eval_shape');
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return { ...(this.fields.get(key) ?? {}) };
  }

  async pttl(key: string): Promise<number> {
    return this.ttl.get(key) ?? -2;
  }
}

test('presence key uses a Redis Cluster hash tag per machine', () => {
  assert.equal(
    machinePresenceKey('machine_00000001'),
    'gpubnb:machine-presence:{machine_00000001}:v1',
  );
});

test('new connection fences an older gateway connection', async () => {
  const redis = new FakePresenceRedis();
  const first = await claimMachinePresence(redis, {
    machineId: 'machine_00000001',
    gatewayId: 'gateway_eu_0001',
    region: 'eu-west',
    nowMs: 1_000,
  });
  assert.equal((await touchMachinePresence(redis, {
    machineId: first.machineId,
    connectionId: first.connectionId,
    sequence: 1,
    phase: 'MINING',
    nowMs: 1_500,
  })).accepted, true);

  const second = await claimMachinePresence(redis, {
    machineId: first.machineId,
    gatewayId: 'gateway_eu_0002',
    region: 'eu-west',
    phase: 'RESERVED',
    nowMs: 2_000,
  });
  assert.notEqual(second.connectionId, first.connectionId);

  const stale = await touchMachinePresence(redis, {
    machineId: first.machineId,
    connectionId: first.connectionId,
    sequence: 2,
    phase: 'AVAILABLE',
    nowMs: 2_100,
  });
  assert.deepEqual(stale, { accepted: false, reason: 'STALE_CONNECTION', sequence: -1 });
  assert.equal(await releaseMachinePresence(redis, first.machineId, first.connectionId), false);

  const current = await readMachinePresence(redis, first.machineId);
  assert.equal(current?.connectionId, second.connectionId);
  assert.equal(current?.phase, 'RESERVED');
  assert.equal(await releaseMachinePresence(redis, first.machineId, second.connectionId), true);
  assert.equal(await readMachinePresence(redis, first.machineId), null);
});

test('presence rejects replayed or out-of-order sequence numbers', async () => {
  const redis = new FakePresenceRedis();
  const claim = await claimMachinePresence(redis, {
    machineId: 'machine_00000002',
    gatewayId: 'gateway_us_0001',
    region: 'us-east',
  });
  const accepted = await touchMachinePresence(redis, {
    machineId: claim.machineId,
    connectionId: claim.connectionId,
    sequence: 7,
    phase: 'RENTED',
  });
  assert.deepEqual(accepted, { accepted: true, sequence: 7 });
  const replay = await touchMachinePresence(redis, {
    machineId: claim.machineId,
    connectionId: claim.connectionId,
    sequence: 7,
    phase: 'AVAILABLE',
  });
  assert.deepEqual(replay, { accepted: false, reason: 'STALE_SEQUENCE', sequence: 7 });
});
