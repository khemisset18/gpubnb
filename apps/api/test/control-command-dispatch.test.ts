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

test('protocol understands mining kinds while production dispatch keeps them dark', async () => {
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
    /machine_command_not_production_fast_path/,
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
