import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { BookingStatus, JobStatus, PrismaClient, SessionTerminationReason, WorkspaceSessionStatus } from '@prisma/client';
import { requestWorkspaceSessionStop } from '../src/workspace-session-stop.js';

const integration = process.env.DATABASE_URL ? test : test.skip;

// Only CI's ephemeral PostgreSQL fixture; no Host, Windows service or
// deployment is involved. The same helper is used by POST /workspace-sessions/:id/stop.
integration('STOP is monotonic and idempotent for owner and renter', async () => {
  const db = new PrismaClient();
  const { seedReadySession } = await import('./fixtures/native-gateway-session.js');
  const fixture = await seedReadySession(db, crypto.randomBytes(8).toString('hex'), {
    bookingStatus: BookingStatus.STARTING, expectedSeconds: 900,
  });
  try {
    await db.job.update({ where: { id: fixture.session.jobId! }, data: { status: JobStatus.RUNNING } });
    const first = await requestWorkspaceSessionStop(db, fixture.session.id, fixture.owner.id);
    assert.deepEqual(first, {
      kind: 'accepted', id: fixture.session.id,
      status: WorkspaceSessionStatus.STOP_REQUESTED, alreadyRequested: false,
    });
    const second = await requestWorkspaceSessionStop(db, fixture.session.id, fixture.renter.id);
    assert.deepEqual(second, {
      kind: 'accepted', id: fixture.session.id,
      status: WorkspaceSessionStatus.STOP_REQUESTED, alreadyRequested: true,
    });
    const row = await db.workspaceSession.findUniqueOrThrow({ where: { id: fixture.session.id } });
    assert.equal(row.terminationReason, SessionTerminationReason.OWNER_EMERGENCY_STOP,
      'a repeated renter STOP may not overwrite the original owner emergency reason');
    assert.equal(await db.workspaceSessionEvent.count({
      where: { sessionId: fixture.session.id, action: { in: ['EMERGENCY_STOP_REQUESTED', 'STOP_REQUESTED'] } },
    }), 1, 'only one STOP event may be created');
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: fixture.session.jobId! } })).status,
      JobStatus.CANCEL_REQUESTED, 'the winning STOP cancels the live job');
    await db.workspaceSession.update({
      where: { id: fixture.session.id }, data: { status: WorkspaceSessionStatus.STOPPING },
    });
    const stopping = await requestWorkspaceSessionStop(db, fixture.session.id, fixture.owner.id);
    assert.deepEqual(stopping, {
      kind: 'accepted', id: fixture.session.id,
      status: WorkspaceSessionStatus.STOPPING, alreadyRequested: true,
    });
  } finally { await fixture.cleanup(); await db.$disconnect(); }
});

for (const terminal of [WorkspaceSessionStatus.COMPLETED, WorkspaceSessionStatus.TIMED_OUT] as const) {
  integration(`stale STOP cannot resurrect a ${terminal} session after concurrent Agent completion`, async () => {
    const db = new PrismaClient();
    const { seedReadySession } = await import('./fixtures/native-gateway-session.js');
    const fixture = await seedReadySession(db, crypto.randomBytes(8).toString('hex'), {
      bookingStatus: BookingStatus.STARTING, expectedSeconds: 900,
    });
    try {
      // requestWorkspaceSessionStop first reads READY. The proxy arranges a
      // real committed PostgreSQL status change just before its transaction,
      // reproducing the browser-STOP / Agent-cleanup interleaving deterministically.
      let updatedBeforeCas = false;
      const concurrent = new Proxy(db, { get(target, property) {
        if (property === '$transaction') {
          return async (callback: Parameters<PrismaClient['$transaction']>[0], options: unknown) => {
            if (!updatedBeforeCas) {
              updatedBeforeCas = true;
              await db.workspaceSession.update({
                where: { id: fixture.session.id },
                data: { status: terminal, endedAt: new Date() },
              });
            }
            return db.$transaction(callback as never, options as never);
          };
        }
        return Reflect.get(target, property);
      } }) as PrismaClient;
      const result = await requestWorkspaceSessionStop(concurrent, fixture.session.id, fixture.renter.id);
      assert.deepEqual(result, { kind: 'not_active', status: terminal });
      assert.equal(updatedBeforeCas, true, 'the controlled competing commit must occur');
      const row = await db.workspaceSession.findUniqueOrThrow({ where: { id: fixture.session.id } });
      assert.equal(row.status, terminal, 'a stale STOP must not reopen a finished session');
      assert.equal(row.terminationReason, null, 'the rejected STOP cannot modify termination reason');
      assert.equal(await db.workspaceSessionEvent.count({
        where: { sessionId: fixture.session.id, action: { in: ['EMERGENCY_STOP_REQUESTED', 'STOP_REQUESTED'] } },
      }), 0, 'the losing STOP creates no event');
    } finally { await fixture.cleanup(); await db.$disconnect(); }
  });
}

integration('STOP never reveals or modifies a session owned by another user', async () => {
  const db = new PrismaClient();
  const { seedReadySession } = await import('./fixtures/native-gateway-session.js');
  const a = await seedReadySession(db, crypto.randomBytes(8).toString('hex'), {
    bookingStatus: BookingStatus.STARTING, expectedSeconds: 900,
  });
  const b = await seedReadySession(db, crypto.randomBytes(8).toString('hex'), {
    bookingStatus: BookingStatus.STARTING, expectedSeconds: 900,
  });
  try {
    assert.deepEqual(await requestWorkspaceSessionStop(db, a.session.id, b.renter.id), {
      kind: 'not_found',
    });
    assert.equal((await db.workspaceSession.findUniqueOrThrow({ where: { id: a.session.id } })).status,
      WorkspaceSessionStatus.READY);
  } finally { await b.cleanup(); await a.cleanup(); await db.$disconnect(); }
});
