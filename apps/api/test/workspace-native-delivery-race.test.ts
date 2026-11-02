import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import Fastify from 'fastify';
import WebSocket from 'ws';

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'isolated-test-session-secret-0123456789';
process.env.INTERNAL_SERVICE_TOKEN ??= 'isolated-test-internal-token-0123456789';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';
const { registerWorkspaceGatewayRoutes } = await import('../src/workspace-gateway.js');

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Execute the real upgrade callback and pump with controlled I/O and a fake
// socket. No TCP listener, real machine, or Windows session is touched.
for (const revoke of ['none', 'cookie', 'binding', 'socket'] as const) {
  test(`native pump drops buffered video when ${revoke} changes during the per-frame DB read`, { timeout: 10_000 }, async t => {
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
          return values.get(args[0]!) === args[count] && values.get(args[1]!) === args[count + 1] ? 1 : 0;
        }
        return 1;
      },
    };
    const db = { workspaceSession: { findFirst: async () => {
      reads++;
      if (reads === 3) { entered.resolve(); await release.promise; }
      return row; // Deliberately return a stale positive after the barrier.
    } } };
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
    assert.equal(finalFences, revoke === 'socket' ? 0 : 1, 'the real pump must execute the final atomic Redis fence');
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
