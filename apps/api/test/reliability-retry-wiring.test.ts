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

test('workspace stopped route retries both replay-safe Serializable cleanup transactions and deletes Redis only after commit', async () => {
  const source = await readFile(new URL('../src/workspace-gateway.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/workspace-gateway/:sessionId/stopped'");
  // The route contains nested callbacks whose own `});` terminators appear before the
  // Fastify route ends. Bound this slice by the next top-level gateway declaration instead.
  const end = source.indexOf('const wss=new WebSocketServer', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end).replace(/\s+/g, '');
  assert.equal((body.match(/runBookingTransaction\(db,asynctx=>/g) ?? []).length, 2);
  assert.equal((body.match(/isolationLevel:Prisma\.TransactionIsolationLevel\.Serializable,maxWait:5_000,timeout:10_000/g) ?? []).length, 2);
  const cleanupTx = body.lastIndexOf('runBookingTransaction(db,asynctx=>');
  const redisDelete = body.indexOf('redis.del(wsSessionActivatedKey(sessionId))');
  assert.ok(cleanupTx >= 0 && redisDelete > cleanupTx, 'Redis cleanup must not be replayed inside the transaction callback');
});
