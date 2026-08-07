import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('ensureComputePreparation is Serializable and recovers from the WorkspaceSession.bookingId race (C7)', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

  const fnStart = source.indexOf('async function ensureComputePreparation(');
  assert.ok(fnStart >= 0);
  const fnEnd = source.indexOf('\nconst activeWorkspaceSessions', fnStart);
  assert.ok(fnEnd > fnStart);
  const fnBody = source.slice(fnStart, fnEnd);

  assert.ok(
    fnBody.includes('isolationLevel:Prisma.TransactionIsolationLevel.Serializable'),
    'the workspace-session + job creation transaction must be Serializable, matching every other multi-write transaction on the money-adjacent path',
  );
  assert.ok(
    fnBody.includes("error.code==='P2002'") && fnBody.includes('db.workspaceSession.findFirst'),
    'a WorkspaceSession.bookingId unique-constraint collision must be treated as a race won by a concurrent caller, not a hard failure',
  );
});

test('the workspace-sessions route never returns a raw Prisma error message to the client (C7)', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

  const route = source.indexOf("app.post('/bookings/:bookingId/workspace-sessions'");
  assert.ok(route >= 0);
  const line = source.slice(route, source.indexOf('\n', route));

  assert.ok(
    line.includes('error instanceof Prisma.PrismaClientKnownRequestError') &&
      line.includes("reply.code(409).send({error:'workspace_preparation_failed'})"),
    'a PrismaClientKnownRequestError must be logged server-side and replaced with a generic message before it reaches the API response',
  );
});
