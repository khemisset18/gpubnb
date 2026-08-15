import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';

import {
  WorkspaceStopFinalizationError,
  finalizeVerifiedDeveloperStop,
} from '../src/workspace-stop-finalizer.js';

const ids = {
  session: 'cm000000000000000000001',
  booking: 'cm000000000000000000002',
  machine: 'cm000000000000000000003',
};

function fakeRedis(deleted: string[]): Redis {
  return {
    del: async (...keys: string[]) => {
      deleted.push(...keys);
      return keys.length;
    },
  } as unknown as Redis;
}

test('verified activated Developer cleanup finalizes once and releases an idle machine', async () => {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const tx = {
    $executeRaw: async () => { calls.push({ name: 'lock' }); return 1; },
    workspaceSession: {
      findFirst: async () => ({
        id: ids.session,
        bookingId: ids.booking,
        startedAt: new Date('2026-08-15T01:00:00.000Z'),
        status: 'STOP_REQUESTED',
      }),
      update: async (args: unknown) => { calls.push({ name: 'session.update', args }); return {}; },
    },
    booking: { updateMany: async () => { calls.push({ name: 'booking.updateMany' }); return { count: 0 }; } },
    payment: { updateMany: async () => { calls.push({ name: 'payment.updateMany' }); return { count: 0 }; } },
    machine: {
      updateMany: async (args: unknown) => { calls.push({ name: 'machine.updateMany', args }); return { count: 1 }; },
    },
  };
  const db = {
    $transaction: async (handler: (value: typeof tx) => unknown) => handler(tx),
  };
  const deleted: string[] = [];

  const result = await finalizeVerifiedDeveloperStop(
    db as never,
    fakeRedis(deleted),
    ids.session,
    ids.machine,
    new Date('2026-08-15T02:00:00.000Z'),
  );

  assert.deepEqual(result, {
    sessionId: ids.session,
    alreadyFinalized: false,
    activated: true,
    machineReleased: true,
  });
  assert.deepEqual(calls.map((entry) => entry.name), ['lock', 'session.update', 'machine.updateMany']);
  assert.deepEqual(deleted, [`workspace-gateway:ws-session-activated:${ids.session}`]);
  const sessionWrite = calls.find((entry) => entry.name === 'session.update')?.args as {
    data?: { status?: string; endedAt?: Date };
  };
  assert.equal(sessionWrite.data?.status, 'COMPLETED');
  assert.equal(sessionWrite.data?.endedAt?.toISOString(), '2026-08-15T02:00:00.000Z');
});

test('already terminal session is an idempotent success with no second state mutation', async () => {
  const calls: string[] = [];
  const tx = {
    $executeRaw: async () => { calls.push('lock'); return 1; },
    workspaceSession: {
      findFirst: async () => ({
        id: ids.session,
        bookingId: ids.booking,
        startedAt: new Date('2026-08-15T01:00:00.000Z'),
        status: 'COMPLETED',
      }),
      update: async () => { calls.push('session.update'); return {}; },
    },
    booking: { updateMany: async () => { calls.push('booking.updateMany'); return { count: 0 }; } },
    payment: { updateMany: async () => { calls.push('payment.updateMany'); return { count: 0 }; } },
    machine: { updateMany: async () => { calls.push('machine.updateMany'); return { count: 0 }; } },
  };
  const db = { $transaction: async (handler: (value: typeof tx) => unknown) => handler(tx) };
  const deleted: string[] = [];

  const result = await finalizeVerifiedDeveloperStop(
    db as never,
    fakeRedis(deleted),
    ids.session,
    ids.machine,
  );

  assert.deepEqual(result, {
    sessionId: ids.session,
    alreadyFinalized: true,
    activated: true,
    machineReleased: false,
  });
  assert.deepEqual(calls, ['lock']);
  assert.deepEqual(deleted, [`workspace-gateway:ws-session-activated:${ids.session}`]);
});

test('missing or non-Developer session fails closed', async () => {
  const tx = {
    $executeRaw: async () => 1,
    workspaceSession: { findFirst: async () => null },
  };
  const db = { $transaction: async (handler: (value: typeof tx) => unknown) => handler(tx) };

  await assert.rejects(
    finalizeVerifiedDeveloperStop(db as never, fakeRedis([]), ids.session, ids.machine),
    (error: unknown) => error instanceof WorkspaceStopFinalizationError
      && error.code === 'workspace_stop_session_not_found',
  );
});
