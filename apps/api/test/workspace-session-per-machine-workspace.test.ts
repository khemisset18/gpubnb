import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// WorkspaceSession.bookingId used to be @unique on its own, so the first session ever
// created for a booking - typically the automatic compute session
// ensureComputePreparation() creates on funding - silently blocked any other
// workspace type, including a renter-requested Developer session, from ever being
// created for that same booking. These tests guard the schema constraint and the two
// route-level fixes together, so a future change can't reintroduce the bug piecemeal.

test('WorkspaceSession is unique per (bookingId, machineWorkspaceId), not per bookingId alone', async () => {
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const start = schema.indexOf('model WorkspaceSession {');
  assert.ok(start >= 0);
  const end = schema.indexOf('\n}', start);
  const body = schema.slice(start, end);

  assert.doesNotMatch(
    body,
    /bookingId String @unique/,
    'bookingId must not be uniquely constrained on its own - that is what blocked a booking from ever having both a compute and a Developer session',
  );
  assert.match(
    body,
    /@@unique\(\[bookingId, ?machineWorkspaceId\]\)/,
    'the real constraint is one session per (booking, workspace type)',
  );
});

test('a matching migration drops the old constraint and creates the composite one', async () => {
  const migration = await readFile(
    new URL(
      '../prisma/migrations/20260810050000_workspace_session_per_machine_workspace/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(migration, /DROP INDEX IF EXISTS "WorkspaceSession_bookingId_key"/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "WorkspaceSession_bookingId_machineWorkspaceId_key" ON "WorkspaceSession"\("bookingId", "machineWorkspaceId"\)/,
  );
});

test('requesting a Developer session scopes its existing-session lookup to the Developer machineWorkspace', async () => {
  const source = await readFile(new URL('../src/workspace-renter-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/bookings/:bookingId/workspace/developer'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n  });', start);
  const body = source.slice(start, end).replace(/\s+/g, '');

  assert.match(
    body,
    /workspaceSession\.findFirst\(\{where:\{bookingId,renterId:session\.userId,machineWorkspaceId:machineWorkspace\.id\}/,
    'an automatic compute session for the same booking must never be returned here instead of creating (or finding) the Developer one the renter actually asked for',
  );
});

test('the Developer workspace status and access routes never return an unrelated compute session', async () => {
  const source = await readFile(new URL('../src/workspace-renter-routes.ts', import.meta.url), 'utf8');
  const statusRoute = source.indexOf("app.get('/bookings/:bookingId/workspace'");
  const accessRoute = source.indexOf("app.post('/bookings/:bookingId/workspace/access'");
  assert.ok(statusRoute >= 0 && accessRoute >= 0);

  for (const [name, start] of [['status', statusRoute], ['access', accessRoute]] as const) {
    const end = source.indexOf('\n  });', start);
    const body = source.slice(start, end).replace(/\s+/g, '');
    assert.match(
      body,
      /machineWorkspace:\{workspace:\{slug:'developer'\}\}/,
      `the ${name} route must scope its lookup to the Developer workspace slug`,
    );
  }
});
