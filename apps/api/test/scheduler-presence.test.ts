import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';

import {
  SchedulerPresenceError,
  assertSchedulerMachinePresence,
  configureSchedulerPresence,
  resetSchedulerPresenceForTests,
  schedulerPresenceBucket,
  schedulerPresenceDecision,
} from '../src/scheduler-presence.js';

const machineId = 'machine_00000001';
const rolloutEnv = (scheduler = '10000', agent = '10000'): NodeJS.ProcessEnv => ({
  SCHEDULER_HOT_PRESENCE_ROLLOUT_BPS: scheduler,
  AGENT_CONTROL_CHANNEL_ROLLOUT_BPS: agent,
});

function redisWith(fields: Record<string, string>, ttlMs = 60_000): Redis {
  return {
    hgetall: async () => fields,
    pttl: async () => ttlMs,
  } as unknown as Redis;
}

function liveFields(phase = 'DRAINING'): Record<string, string> {
  return {
    connectionId: 'conn_0123456789abcdef0123456789abcdef',
    gatewayId: 'gateway_eu_0001',
    region: 'eu-west-1',
    sequence: '3',
    phase,
    lastSeenAtMs: '1786752000000',
  };
}

test.afterEach(() => resetSchedulerPresenceForTests());

test('presence bucket is deterministic and bounded', () => {
  assert.equal(schedulerPresenceBucket(machineId), schedulerPresenceBucket(machineId));
  assert.ok(schedulerPresenceBucket(machineId) >= 0 && schedulerPresenceBucket(machineId) < 10_000);
});

test('hot rollout cannot exceed parent Agent QUIC rollout', () => {
  assert.throws(
    () => configureSchedulerPresence(redisWith({}), 'hot', rolloutEnv('5000', '1000')),
    /scheduler_hot_presence_rollout_exceeds_agent_control_rollout/,
  );
});

test('legacy mode never blocks allocation on missing Redis presence', async () => {
  configureSchedulerPresence(redisWith({}, -2), 'legacy', rolloutEnv());
  await assert.doesNotReject(assertSchedulerMachinePresence(machineId));
  assert.deepEqual(await schedulerPresenceDecision(machineId), {
    mode: 'legacy', assigned: false, live: true,
  });
});

test('shadow mode observes missing presence without blocking allocation', async () => {
  configureSchedulerPresence(redisWith({}, -2), 'shadow', rolloutEnv());
  const decision = await schedulerPresenceDecision(machineId);
  assert.equal(decision.live, false);
  assert.equal(decision.assigned, false);
  await assert.doesNotReject(assertSchedulerMachinePresence(machineId));
});

test('hot mode with zero rollout remains non-blocking', async () => {
  configureSchedulerPresence(redisWith({}, -2), 'hot', rolloutEnv('0', '10000'));
  await assert.doesNotReject(assertSchedulerMachinePresence(machineId));
});

test('assigned hot machine must have a live gateway presence', async () => {
  configureSchedulerPresence(redisWith({}, -2), 'hot', rolloutEnv());
  await assert.rejects(
    assertSchedulerMachinePresence(machineId),
    (error: unknown) => error instanceof SchedulerPresenceError && error.code === 'machine_hot_presence_offline',
  );
});

test('live DRAINING phase proves connectivity but does not invent business availability', async () => {
  configureSchedulerPresence(redisWith(liveFields('DRAINING')), 'hot', rolloutEnv());
  const decision = await schedulerPresenceDecision(machineId);
  assert.equal(decision.live, true);
  assert.equal(decision.phase, 'DRAINING');
  await assert.doesNotReject(assertSchedulerMachinePresence(machineId));
});

test('quarantined hot machine is rejected', async () => {
  configureSchedulerPresence(redisWith(liveFields('QUARANTINED')), 'hot', rolloutEnv());
  await assert.rejects(
    assertSchedulerMachinePresence(machineId),
    (error: unknown) => error instanceof SchedulerPresenceError && error.code === 'machine_hot_presence_quarantined',
  );
});

test('Redis errors fail closed only for assigned hot machines', async () => {
  const broken = {
    hgetall: async () => { throw new Error('redis_down'); },
    pttl: async () => { throw new Error('redis_down'); },
  } as unknown as Redis;
  configureSchedulerPresence(broken, 'hot', rolloutEnv());
  await assert.rejects(
    assertSchedulerMachinePresence(machineId),
    (error: unknown) => error instanceof SchedulerPresenceError && error.code === 'machine_hot_presence_unavailable',
  );

  resetSchedulerPresenceForTests();
  configureSchedulerPresence(broken, 'shadow', rolloutEnv());
  await assert.doesNotReject(assertSchedulerMachinePresence(machineId));
});
