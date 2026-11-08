import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production heartbeat retries only the PostgreSQL transaction after one-time Redis challenge consumption', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/heartbeat'");
  const end = source.indexOf("const publicWorkspace=", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end).replace(/\s+/g, '');
  const challenge = body.indexOf('redis.getdel(`agent-challenge:');
  const retry = body.indexOf('constheartbeatResult=awaitrunBookingTransaction(db,asynctx=>{');
  assert.ok(challenge >= 0 && retry > challenge, 'one-time challenge consumption must stay outside and before the retried DB callback');
  assert.match(body, /isolationLevel:Prisma\.TransactionIsolationLevel\.Serializable,maxWait:5_000,timeout:10_000/);
  const callback = body.slice(retry, body.indexOf('return{ok:true,publishable:heartbeatResult.publishable', retry));
  assert.doesNotMatch(callback, /redis\./, 'retry callback must remain PostgreSQL-only');
});

test('workspace stopped route uses one replay-safe Serializable CAS cleanup and tombstones Redis only after commit', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/workspace-gateway/:sessionId/stopped'");
  // The route contains nested callbacks whose own `});` terminators appear before the
  // Fastify route ends. Bound this slice by the next top-level gateway declaration instead.
  const end = source.indexOf('const wss=new WebSocketServer', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end).replace(/\s+/g, '');
  // Cleanup is now one Serializable CAS transaction. A second transaction
  // based on a pre-read row could overwrite a concurrent terminal winner.
  assert.equal((body.match(/runBookingTransaction\(db,asynctx=>/g) ?? []).length, 1);
  assert.equal((body.match(/isolationLevel:Prisma\.TransactionIsolationLevel\.Serializable,maxWait:5_000,timeout:10_000/g) ?? []).length, 1);
  assert.match(body, /constchanged=awaittx\.workspaceSession\.updateMany\(/);
  assert.match(body, /if\(changed\.count!==1\)return\{error:'workspace_not_stoppable'\}asconst/);
  const cleanupTx = body.indexOf('runBookingTransaction(db,asynctx=>');
  const redisRevoke = body.indexOf('revokeGatewayAuthority(redis,sessionId)');
  assert.ok(cleanupTx >= 0 && redisRevoke > cleanupTx, 'Redis revocation must not be replayed inside the transaction callback');
});

test('browser STOP publishes the generation tombstone before reporting success', async () => {
  const source = (await readFile(new URL('../src/server.ts', import.meta.url), 'utf8')).replace(/\s+/g, '');
  const start = source.indexOf("app.post('/workspace-sessions/:id/stop'");
  const end = source.indexOf("constmetricInput=", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  const databaseStop = route.indexOf('requestWorkspaceSessionStop(db,id,session.userId)');
  const redisRevoke = route.indexOf('awaitrevokeGatewayAuthority(redis,id)');
  const success = route.lastIndexOf('return{id:outcome.id,status:outcome.status');
  assert.ok(databaseStop >= 0 && redisRevoke > databaseStop && success > redisRevoke,
    'STOP success must follow the durable transition and Redis tombstone');
});
