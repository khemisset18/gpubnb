import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WorkspaceRuntimeBackend } from '@prisma/client';
import Fastify from 'fastify';
import WebSocket from 'ws';

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'isolated-test-session-secret-0123456789';
process.env.INTERNAL_SERVICE_TOKEN ??= 'isolated-test-internal-token-0123456789';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';
const { authorizeQueuedGatewayRelay, markNativeGatewayRevocationStarted, registerWorkspaceGatewayRoutes, withNativeGatewaySessionFence } = await import('../src/workspace-gateway.js');

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('native session expiry during an in-flight final Redis fence denies its send commit', async () => {
  const entered = barrier(), release = barrier();
  const db = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      $queryRaw: async () => [{ id: 's', machineId: 'm', renterId: 'u', runtimeBackend: WorkspaceRuntimeBackend.WINDOWS_NATIVE, remainingMs: 250n }],
    }),
  };
  const pending = withNativeGatewaySessionFence(db as never, 's', 'm', 'u', WorkspaceRuntimeBackend.WINDOWS_NATIVE, async isActive => {
    entered.resolve();
    await release.promise;
    return isActive();
  });
  await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 300));
  release.resolve();
  assert.equal(await pending, false, 'authorization must be checked again at the send/enqueue commit point');
});

test('native mutation fence requests an UPDATE row lock and passes the same transaction to its callback', async () => {
  let queryText = '', queryValues:unknown[]=[];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray,...values:unknown[]) => {
      queryText = strings.join('?');
      queryValues=values;
      return [{id:'s',machineId:'m',renterId:'u',runtimeBackend:WorkspaceRuntimeBackend.WINDOWS_NATIVE,remainingMs:60_000n}];
    },
  };
  const db = {$transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx)};
  let callbackTx: unknown;
  const accepted = await withNativeGatewaySessionFence(
    db as never, 's', 'm', 'u', WorkspaceRuntimeBackend.WINDOWS_NATIVE,
    async (isActive, currentTx) => { callbackTx=currentTx; return isActive(); },
    {lockSessionForMutation:true},
  );
  assert.equal(accepted,true);
  assert.equal(callbackTx,tx);
  assert.match(queryText,/FOR \? OF ws FOR SHARE OF m,mw,w/);
  assert.ok(queryValues.some(value=>(value as {sql?:string}|null)?.sql==='UPDATE'));
});

test('native mutation fence rolls back writes when expiry invalidates its final commit check', async () => {
  let rolledBack = false, committed = false;
  const tx = {
    $queryRaw: async () => [{id:'s',machineId:'m',renterId:'u',runtimeBackend:WorkspaceRuntimeBackend.WINDOWS_NATIVE,remainingMs:60_000n}],
    workspaceSession: {update: async () => { committed = true; }},
  };
  const db = {$transaction: async (operation: (value: unknown) => Promise<unknown>) => {
    try { return await operation(tx); }
    catch (error) { rolledBack = true; committed = false; throw error; }
  }};
  const accepted = await withNativeGatewaySessionFence(
    db as never, 's', 'm', 'u', WorkspaceRuntimeBackend.WINDOWS_NATIVE,
    async (_isActive, currentTx) => {
      await (currentTx as typeof tx).workspaceSession.update();
      return false;
    },
    {lockSessionForMutation:true},
  );
  assert.equal(accepted,false);
  assert.equal(rolledBack,true);
  assert.equal(committed,false,'writes preceding an expired/revoked final check must not commit');
});

test('native WTS revocation takes the session UPDATE lock and blocks later delivery before helper cleanup', async () => {
  let queryText = '', status = 'READY', updateCount = 0, authorityTombstoned = false;
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => { queryText = strings.join('?'); return [{id:'s'}]; },
    workspaceSession: {
      findUnique: async () => ({status}),
      updateMany: async (args: {where:{status:string};data:{status:string}}) => {
        assert.equal(args.where.status,status);
        assert.equal(args.data.status,'STOPPING');
        status='STOPPING';updateCount++;return {count:1};
      },
    },
    workspaceSessionEvent: {create: async () => ({})},
  };
  const db = {$transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx)};
  const redis = {eval: async (script:string,_keyCount:number,key:string,prefix:string) => {
    authorityTombstoned=key==='workspace-gateway:ws-session-activated:s'&&prefix==='revoked:'&&script.includes("redis.call('SET', KEYS[1]");
    return 1;
  }};
  assert.equal(await markNativeGatewayRevocationStarted(db as never,redis as never,'s','m'),true);
  assert.match(queryText,/FOR UPDATE OF ws/);
  assert.equal(updateCount,1);
  assert.equal(status,'STOPPING');
  assert.equal(authorityTombstoned,true,'revocation must replace the generation instead of deleting its fence');
});

test('native queued relay whose cookie read began before STOP cannot restore authorization', async () => {
  const entered = barrier(), release = barrier();
  let revoked = false, finalRedisChecks = 0;
  const binding = JSON.stringify({sessionId:'s',machineId:'m',browserSessionKey:'cookie',runtimeBackend:'WINDOWS_NATIVE'});
  const db = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      $queryRaw: async () => revoked ? [] : [{id:'s',machineId:'m',renterId:'u',runtimeBackend:'WINDOWS_NATIVE',remainingMs:60_000n}],
    }),
  };
  const redis = {
    get: async () => { entered.resolve(); await release.promise; return JSON.stringify({sessionId:'s',userId:'u'}); },
    eval: async () => { finalRedisChecks++; return 1; },
  };
  const pending = authorizeQueuedGatewayRelay(db as never,redis as never,'m',{
    id:'r',sessionId:'s',kind:'ws_send',channelId:'c',nativeChannelBinding:binding,dataBase64:'AA==',binary:true,
  });
  await entered.promise;
  revoked = true;
  release.resolve();
  assert.equal(await pending,null);
  assert.equal(finalRedisChecks,0,'the row-locked STOP check must reject before final channel authority can pass');
});

// Execute the real upgrade callback and pump with controlled I/O and a fake
// socket. No TCP listener, real machine, or Windows session is touched.
for (const revoke of ['none', 'cookie', 'binding', 'socket'] as const) {
  test(`native pump drops buffered video when ${revoke} changes during the final Redis fence`, { timeout: 10_000 }, async t => {
    const app = Fastify();
    t.after(() => app.close());
    const cookieKey = 'workspace-gateway-session:' + crypto.createHash('sha256').update('test-token').digest('hex');
    const values = new Map<string, string>([[cookieKey, JSON.stringify({ sessionId: 's', userId: 'u' })]]);
    const entered = barrier(), release = barrier(), closed = barrier(), installed = barrier(), delivered = barrier();
    const row = { id: 's', renterId: 'u', machineId: 'm', runtimeBackend: 'WINDOWS_NATIVE', expiresAt: new Date(Date.now() + 60000) };
    let reads = 0, sent = 0, popped = false, finalFences = 0;
    let pump!: () => void;
    class FakeSocket extends EventEmitter {
      readyState = WebSocket.OPEN;
      bufferedAmount = 0;
      send() { sent++; delivered.resolve(); }
      close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1008, Buffer.alloc(0)); closed.resolve(); }
    }
    const socket = new FakeSocket();
    const redis = {
      get: async (key: string) => values.get(key) ?? null,
      getdel: async () => JSON.stringify({ status: 101 }),
      set: async (key: string, value: string) => { values.set(key, value); return 'OK'; },
      del: async (...keys: string[]) => { keys.forEach(key => values.delete(key)); return 1; },
      rpop: async () => {
        if (popped) return null;
        popped = true;
        return JSON.stringify({ dataBase64: 'AA==', binary: true });
      },
      eval: async (script: string, count: number, ...args: string[]) => {
        if (script.includes('Final Redis read')) {
          finalFences++;
          if (finalFences === 1) { entered.resolve(); await release.promise; }
          return values.get(args[0]!) === args[count] && values.get(args[1]!) === args[count + 1] ? 1 : 0;
        }
        return 1;
      },
    };
    const findWorkspace = async () => { reads++; return row; };
    const db = {
      workspaceSession: { findFirst: findWorkspace },
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: 's', machineId: 'm', renterId: 'u', runtimeBackend: 'WINDOWS_NATIVE', remainingMs: 60_000n }],
        workspaceSession: { findFirst: findWorkspace },
      }),
    };
    registerWorkspaceGatewayRoutes(app, db as never, redis as never);
    await app.ready();
    t.mock.method(WebSocket.Server.prototype, 'handleUpgrade', (_request: unknown, _socket: unknown, _head: unknown, callback: (ws: unknown) => void) => callback(socket));
    t.mock.method(globalThis, 'setInterval', ((callback: () => void) => { pump = callback; installed.resolve(); return {} as NodeJS.Timeout; }) as typeof setInterval);
    app.server.emit('upgrade', { url: '/workspace-gateway/s/native-stream', headers: { host: 'localhost', cookie: 'gpubnb_workspace=test-token' } }, {}, Buffer.alloc(0));
    await installed.promise;
    pump();
    await entered.promise;
    if (revoke === 'cookie') values.delete(cookieKey);
    if (revoke === 'binding') {
      const key = [...values.keys()].find(key => key.startsWith('workspace-gateway:ws-channel:'))!;
      values.set(key, values.get(key)! + ' ');
    }
    if (revoke === 'socket') socket.close();
    release.resolve();
    // Let the pump's asynchronous continuation and its close handler finish.
    if (revoke === 'none') await delivered.promise;
    else if (revoke !== 'socket') await closed.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sent, revoke === 'none' ? 1 : 0, 'only an authorized buffered frame may reach ws.send');
    assert.equal(finalFences, 1, 'the real pump must reach the atomic Redis fence even when the socket closes during its DB read');
  });
}


test('native pump skips an expired uncommitted receipt and delivers a later valid retry without closing the channel', { timeout: 10_000 }, async t => {
  const app = Fastify();
  t.after(() => app.close());
  const cookieKey = 'workspace-gateway-session:' + crypto.createHash('sha256').update('test-token').digest('hex');
  const values = new Map<string, string>([[cookieKey, JSON.stringify({ sessionId: 's', userId: 'u' })]]);
  const row = { id: 's', renterId: 'u', machineId: 'm', runtimeBackend: 'WINDOWS_NATIVE', expiresAt: new Date(Date.now() + 60000) };
  const orphan = JSON.stringify({ dataBase64: 'AQ==', binary: true, activationReceiptId: crypto.randomUUID() });
  const retry = JSON.stringify({ dataBase64: 'Ag==', binary: true });
  const queue = [orphan, retry];
  const installed = barrier(), firstPopped = barrier(), delivered = barrier();
  let pump!: () => void, clock = 100, accounted = 0, receiptReads = 0, closes = 0;
  const frames:Buffer[] = [];
  class FakeSocket extends EventEmitter {
    readyState = WebSocket.OPEN;
    bufferedAmount = 0;
    send(data:Buffer) { frames.push(data); delivered.resolve(); }
    close() { closes++; this.readyState = WebSocket.CLOSED; this.emit('close', 1011, Buffer.alloc(0)); }
  }
  const socket = new FakeSocket();
  const redis = {
    get: async (key:string) => values.get(key) ?? null,
    getdel: async () => JSON.stringify({ status:101 }),
    set: async (key:string,value:string) => { values.set(key,value); return 'OK'; },
    del: async (...keys:string[]) => { keys.forEach(key=>values.delete(key)); return 1; },
    rpop: async () => { const frame=queue.shift() ?? null; if(frame===orphan)firstPopped.resolve(); return frame; },
    eval: async (script:string,count:number,...args:string[]) => {
      if(script.includes('Final Redis read'))return values.get(args[0]!)===args[count] && values.get(args[1]!)===args[count+1] ? 1 : 0;
      if(script.includes('currentBytes - tonumber(ARGV[1])'))accounted++;
      return 1;
    },
  };
  const db = {
    workspaceSession: { findFirst: async () => row },
    workspaceGatewayAcceptance: { findUnique: async () => { receiptReads++; return null; } },
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      $queryRaw: async () => [{ id: 's', machineId: 'm', renterId: 'u', runtimeBackend: 'WINDOWS_NATIVE', remainingMs: 60_000n }],
      workspaceSession: { findFirst: async () => row },
      workspaceGatewayAcceptance: { findUnique: async () => { receiptReads++; return null; } },
    }),
  };
  registerWorkspaceGatewayRoutes(app,db as never,redis as never);
  await app.ready();
  t.mock.method(WebSocket.Server.prototype,'handleUpgrade',(_request:unknown,_socket:unknown,_head:unknown,callback:(ws:unknown)=>void)=>callback(socket));
  t.mock.method(globalThis,'setInterval',((callback:()=>void)=>{ pump=callback; installed.resolve(); return {} as NodeJS.Timeout; }) as typeof setInterval);
  t.mock.method(performance,'now',()=>clock);
  app.server.emit('upgrade',{url:'/workspace-gateway/s/native-stream',headers:{host:'localhost',cookie:'gpubnb_workspace=test-token'}},{},Buffer.alloc(0));
  await installed.promise;
  pump();
  await firstPopped.promise;
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(frames.length,0,'missing receipt must never deliver media');
  assert.equal(closes,0,'a pending receipt must not close the socket immediately');
  clock=15101;
  pump();
  await delivered.promise;
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual(frames.map(frame=>frame.toString('hex')),['02'],'only the subsequently valid frame may be delivered');
  assert.equal(closes,0,'an abandoned first frame must not close an otherwise valid browser channel');
  assert.ok(receiptReads>=2,'the missing receipt was rechecked before discarding');
  assert.equal(accounted,2,'orphan and delivered frame both release Redis queue byte accounting');
});
