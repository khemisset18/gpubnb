import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';

import {
  commandAckKey,
  commandDispatchConfigFromEnv,
  commandGatewayAssigned,
  commandKindForDurableType,
  controlEnvelope,
  dispatchToGateway,
  readTerminalGatewayAck,
} from '../src/control-command-dispatch.js';
import type { ClaimedMachineCommand } from '../src/delivery-store.js';

const command = (overrides: Partial<ClaimedMachineCommand> = {}): ClaimedMachineCommand => ({
  id: 'command_00000001',
  machineId: 'machine_00000001',
  commandType: 'stop_rental',
  sequence: 7n,
  idempotencyKey: 'stop_rental:booking_00000001:1',
  expiresAt: new Date('2026-08-15T02:00:00.000Z'),
  payload: {
    sessionId: 'session_00000001',
    workspaceSlug: 'developer',
    reason: 'renter',
    bookingId: 'booking_private_0001',
    renterId: 'renter_private_0001',
    listingId: 'listing_private_0001',
    startsAt: '2026-08-15T01:00:00.000Z',
  },
  status: 'LEASED',
  attempts: 1,
  availableAt: new Date('2026-08-15T01:55:00.000Z'),
  leaseOwner: 'delivery_worker_0001',
  leaseExpiresAt: new Date('2026-08-15T01:56:00.000Z'),
  createdAt: new Date('2026-08-15T01:50:00.000Z'),
  ...overrides,
});

test('gateway command rollout is fail closed by default', () => {
  const config = commandDispatchConfigFromEnv({});
  assert.equal(config.rolloutBps, 0);
  assert.equal(config.agentControlRolloutBps, 0);
  assert.equal(commandGatewayAssigned('machine_00000001', config), false);
});

test('command rollout must be nested inside Agent QUIC rollout', () => {
  assert.throws(
    () => commandDispatchConfigFromEnv({
      MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS: '1000',
      AGENT_CONTROL_CHANNEL_ROLLOUT_BPS: '100',
    }),
    /machine_command_rollout_exceeds_agent_control_rollout/,
  );
});

test('non-zero rollout requires private gateway coordinates and a strong token', () => {
  assert.throws(
    () => commandDispatchConfigFromEnv({
      MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS: '1',
      AGENT_CONTROL_CHANNEL_ROLLOUT_BPS: '1',
    }),
    /machine_command_gateway_config_required_for_rollout/,
  );
  const config = commandDispatchConfigFromEnv({
    MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS: '10000',
    AGENT_CONTROL_CHANNEL_ROLLOUT_BPS: '10000',
    CONTROL_GATEWAY_ADMIN_URL: 'http://control-gateway.internal:9090',
    CONTROL_GATEWAY_INTERNAL_TOKEN: 'x'.repeat(48),
  });
  assert.equal(commandGatewayAssigned('machine_00000001', config), true);
});

test('protocol understands mining kinds while unfenced production mining is rejected', async () => {
  assert.equal(commandKindForDurableType('stop_rental'), 'STOP_RENTAL');
  assert.equal(commandKindForDurableType('start_mining'), 'START_MINING');
  assert.equal(commandKindForDurableType('stop_mining'), 'STOP_MINING');
  assert.equal(commandKindForDurableType('prepare_rental'), undefined);
  assert.equal(commandKindForDurableType('start_rental'), undefined);
  assert.equal(commandKindForDurableType('cleanup_rental'), undefined);

  await assert.rejects(
    dispatchToGateway(
      command({ commandType: 'stop_mining', payload: { resourceId: 'resource_00000001' } }),
      {
        adminUrl: 'http://control-gateway.internal:9090',
        internalToken: 'x'.repeat(48),
        rolloutBps: 10_000,
        agentControlRolloutBps: 10_000,
      },
    ),
    /mining_command_durable_payload_invalid/,
  );
});

test('fenced mining durable payload becomes an exact Gateway lease and payload', () => {
  const envelope = controlEnvelope(command({
    commandType: 'start_mining',
    payload: {
      lease: {
        resourceId: 'resource_00000001',
        holderId: 'mining_resource_00000001',
        leaseId: 'lease_000000001',
        fencingToken: '17',
      },
      payload: {
        resourceId: 'resource_00000001',
        hardwareUuid: 'GPU-aaaaaaaa',
        runtimeGeneration: '17',
        profileId: 'lolminer_etchash',
        poolUrl: 'stratum+tcp://pool.example.com:4444',
        walletAddress: 'wallet123456',
        workerName: 'worker_1',
        performanceMode: 'FULL',
        maximumTemperatureC: 94,
        maximumPowerWatts: 180,
      },
    },
  }));
  assert.deepEqual(envelope.lease, {
    resourceId: 'resource_00000001',
    holderId: 'mining_resource_00000001',
    leaseId: 'lease_000000001',
    fencingToken: '17',
  });
  assert.equal((envelope.payload as Record<string, unknown>).runtimeGeneration, '17');
  assert.equal((envelope.payload as Record<string, unknown>).resourceId, 'resource_00000001');
});

test('fenced STOP_MINING becomes an exact Gateway lease with the minimal stop payload', () => {
  const envelope = controlEnvelope(command({
    commandType: 'stop_mining',
    payload: {
      lease: {
        resourceId: 'resource_00000001',
        holderId: 'mining_resource_00000001',
        leaseId: 'lease_000000001',
        fencingToken: '17',
      },
      payload: {
        resourceId: 'resource_00000001',
        hardwareUuid: 'GPU-aaaaaaaa',
        runtimeGeneration: '17',
      },
    },
  }));
  assert.deepEqual(envelope.lease, {
    resourceId: 'resource_00000001',
    holderId: 'mining_resource_00000001',
    leaseId: 'lease_000000001',
    fencingToken: '17',
  });
  assert.deepEqual(envelope.payload, {
    resourceId: 'resource_00000001',
    hardwareUuid: 'GPU-aaaaaaaa',
    runtimeGeneration: '17',
  });
});

test('mining envelope rejects missing lease, resource mismatch, and invalid lease fences', () => {
  assert.throws(
    () => controlEnvelope(command({
      commandType: 'start_mining',
      payload: {
        payload: {
          resourceId: 'resource_00000001',
          hardwareUuid: 'GPU-aaaaaaaa',
          runtimeGeneration: '17',
        },
      },
    })),
    /mining_command_durable_payload_invalid/,
  );

  assert.throws(
    () => controlEnvelope(command({
      commandType: 'stop_mining',
      payload: {
        lease: {
          resourceId: 'resource_00000002',
          holderId: 'mining_resource_00000001',
          leaseId: 'lease_000000001',
          fencingToken: '17',
        },
        payload: {
          resourceId: 'resource_00000001',
          hardwareUuid: 'GPU-aaaaaaaa',
          runtimeGeneration: '17',
        },
      },
    })),
    /mining_command_fence_mismatch/,
  );

  for (const fencingToken of ['0', '01', '9223372036854775808']) {
    assert.throws(
      () => controlEnvelope(command({
        commandType: 'stop_mining',
        payload: {
          lease: {
            resourceId: 'resource_00000001',
            holderId: 'mining_resource_00000001',
            leaseId: 'lease_000000001',
            fencingToken,
          },
          payload: {
            resourceId: 'resource_00000001',
            hardwareUuid: 'GPU-aaaaaaaa',
            runtimeGeneration: fencingToken,
          },
        },
      })),
      /mining_command_lease_invalid/,
    );
  }
});

test('mining durable wrapper and Agent payload are exact and reject secret or unused fields', () => {
  const lease = {
    resourceId: 'resource_00000001',
    holderId: 'mining_resource_00000001',
    leaseId: 'lease_000000001',
    fencingToken: '17',
  };
  const startPayload = {
    resourceId: 'resource_00000001',
    hardwareUuid: 'GPU-aaaaaaaa',
    runtimeGeneration: '17',
    profileId: 'lolminer_etchash',
    poolUrl: 'stratum+tcp://pool.example.com:4444',
    walletAddress: 'wallet123456',
    workerName: 'worker_1',
    performanceMode: 'FULL',
    maximumTemperatureC: 94,
    maximumPowerWatts: 180,
  };

  assert.throws(
    () => controlEnvelope(command({
      commandType: 'start_mining',
      payload: { lease, payload: startPayload, debug: true },
    })),
    /mining_command_durable_payload_invalid/,
  );

  for (const injected of [
    { ownerPoolSecretRef: 'secret://local/mining/pool-main' },
    { poolPassword: 'must-never-cross-control-plane' },
    { debug: true },
  ]) {
    assert.throws(
      () => controlEnvelope(command({
        commandType: 'start_mining',
        payload: { lease, payload: { ...startPayload, ...injected } },
      })),
      /mining_command_payload_shape_invalid/,
    );
  }

  const envelope = controlEnvelope(command({
    commandType: 'start_mining',
    payload: { lease, payload: startPayload },
  }));
  assert.deepEqual(Object.keys(envelope.payload as Record<string, unknown>).sort(), [
    'hardwareUuid',
    'maximumPowerWatts',
    'maximumTemperatureC',
    'performanceMode',
    'poolUrl',
    'profileId',
    'resourceId',
    'runtimeGeneration',
    'walletAddress',
    'workerName',
  ]);
  assert.equal(JSON.stringify(envelope).includes('ownerPoolSecretRef'), false);
  assert.equal(JSON.stringify(envelope).includes('poolPassword'), false);
});

test('mining envelope rejects a durable fence mismatch before Gateway dispatch', () => {
  assert.throws(
    () => controlEnvelope(command({
      commandType: 'stop_mining',
      payload: {
        lease: {
          resourceId: 'resource_00000001',
          holderId: 'mining_resource_00000001',
          leaseId: 'lease_000000001',
          fencingToken: '18',
        },
        payload: {
          resourceId: 'resource_00000001',
          hardwareUuid: 'GPU-aaaaaaaa',
          runtimeGeneration: '17',
        },
      },
    })),
    /mining_command_fence_mismatch/,
  );
});

test('durable identity is preserved while rental-private fields are stripped before Gateway dispatch', () => {
  const envelope = controlEnvelope(command());
  assert.deepEqual(envelope, {
    protocolVersion: 1,
    commandId: 'command_00000001',
    machineId: 'machine_00000001',
    sequence: 7,
    kind: 'STOP_RENTAL',
    issuedAtMs: Date.parse('2026-08-15T01:50:00.000Z'),
    expiresAtMs: Date.parse('2026-08-15T02:00:00.000Z'),
    payload: {
      sessionId: 'session_00000001',
      workspaceSlug: 'developer',
      reason: 'renter',
    },
  });
  assert.equal(JSON.stringify(envelope).includes('renter_private_0001'), false);
  assert.equal(JSON.stringify(envelope).includes('listing_private_0001'), false);
  assert.throws(
    () => controlEnvelope(command({ sequence: BigInt(Number.MAX_SAFE_INTEGER) + 1n })),
    /machine_command_sequence_not_json_safe/,
  );
});

test('rental stop envelope fails closed without a proven Developer runtime', () => {
  assert.throws(
    () => controlEnvelope(command({ payload: { sessionId: 'session_00000001', workspaceSlug: 'compute' } })),
    /stop_rental_workspace_not_direct/,
  );
  assert.throws(
    () => controlEnvelope(command({ payload: { sessionId: 'session_00000001', workspaceSlug: 'developer', reason: 'other' } })),
    /stop_rental_reason_invalid/,
  );
});

test('terminal Redis ACK must match durable command identity before completion', async () => {
  const fake = {
    pttl: async () => 60_000,
    hgetall: async () => ({
      machineId: 'machine_00000001',
      sequence: '7',
      status: 'SUCCEEDED',
      detailCode: 'rental_cleanup_verified',
    }),
  } as unknown as Redis;
  assert.equal(
    commandAckKey('machine_00000001', 'command_00000001'),
    'gpubnb:command-ack:{machine_00000001}:command_00000001:v1',
  );
  assert.deepEqual(await readTerminalGatewayAck(fake, command()), {
    status: 'SUCCEEDED',
    detailCode: 'rental_cleanup_verified',
  });

  const stale = {
    pttl: async () => 60_000,
    hgetall: async () => ({ machineId: 'machine_00000002', sequence: '7', status: 'SUCCEEDED' }),
  } as unknown as Redis;
  await assert.rejects(readTerminalGatewayAck(stale, command()), /gateway_command_ack_identity_conflict/);
});
