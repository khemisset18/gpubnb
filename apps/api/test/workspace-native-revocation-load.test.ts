import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createGatewayChannelLeaseGuard } from '../src/workspace-gateway-channel-lease.js';
import { acceptGatewayFrame, revokeGatewayAuthority } from '../src/workspace-gateway.js';
import {
  BrowserPendingBudget,
  WS_BROWSER_PENDING_MAX_BYTES,
} from '../src/workspace-gateway-transport.js';

// Synthetic, repeatable load workload: Redis/PostgreSQL are in-memory stubs.
// These timings are NOT production Redis/DB or physical streaming p50/p95/p99.
function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

const authorityKey=(sessionId:string)=>`workspace-gateway:ws-session-activated:${sessionId}`;
const authorityId=(index:number)=>`00000000-0000-4000-8000-${index.toString(16).padStart(12,'0')}`;

function generationRedis(authorities:Map<string,string>,beforeEnqueue?:()=>Promise<void>){
  const counters={gets:0,evals:0};
  return {counters,
    get:async(key:string)=>{counters.gets++;return authorities.get(key)??null;},
    eval:async(script:string,keyCount:number,...values:unknown[])=>{
      counters.evals++;
      const keys=values.slice(0,keyCount).map(String),argv=values.slice(keyCount).map(String);
      if(script.includes("current ~= ARGV[1] and current ~= '1'")){
        const current=authorities.get(keys[0]!);
        if(current&&current!==argv[0]&&current!=='1')return 0;
        authorities.set(keys[0]!,argv[0]!);return 1;
      }
      if(script.includes('string.sub(current, 1, string.len(ARGV[1]))')){
        authorities.set(keys[0]!,argv[0]+argv[1]);return 1;
      }
      if(script.includes('binding and enqueue are linearized')){
        if(beforeEnqueue)await beforeEnqueue();
        return authorities.get(keys[4]!)===argv[7]?1:-2;
      }
      throw new Error('unexpected_generation_test_script');
    },
  };
}

function activeFrame(sessionId:string,machineId:string,channelId:string){
  return {sessionId,machineId,channelId,
    bindingRaw:JSON.stringify({sessionId,machineId,browserSessionKey:`browser:${sessionId}`,runtimeBackend:'WINDOWS_NATIVE'}),
    frame:{dataBase64:'AA==',binary:true,close:false}};
}

async function syntheticGenerationLoad(fps:30|60,channels:number){
  const authorities=new Map<string,string>();
  let postgresReads=0;
  const db={workspaceSession:{findFirst:async()=>{postgresReads++;throw new Error('hot_path_touched_postgres');}},
    $transaction:async()=>{throw new Error('hot_path_opened_transaction');}};
  const redis=generationRedis(authorities),samples:number[]=[];
  for(let channel=0;channel<channels;channel++)authorities.set(authorityKey(`generation-${channel}`),authorityId(channel+1));
  await Promise.all(Array.from({length:channels},async(_,channel)=>{
    for(let frame=0;frame<fps;frame++){
      const started=performance.now();
      const accepted=await acceptGatewayFrame({db:db as never,redis:redis as never,
        ...activeFrame(`generation-${channel}`,`machine-${channel}`,`channel-${channel}`)});
      samples.push(performance.now()-started);assert.equal(accepted.enqueued,1);
    }
  }));
  samples.sort((a,b)=>a-b);
  const frames=fps*channels;
  const result={kind:'synthetic-generation-admission-in-memory-not-production-SLO',fps,channels,frames,
    postgresReads,redisGets:redis.counters.gets,redisEvals:redis.counters.evals,
    p50Ms:percentile(samples,.50),p95Ms:percentile(samples,.95),p99Ms:percentile(samples,.99)};
  assert.equal(postgresReads,0,'a valid generation lease must make the frame path PostgreSQL-free');
  assert.equal(redis.counters.gets,frames);assert.equal(redis.counters.evals,frames);
  console.log('STAGE4_GENERATION_ADMISSION_SYNTHETIC_LOAD '+JSON.stringify(result));
  return result;
}

async function syntheticLoad(fps: 30 | 60, channels: number) {
  let redisBrowserReads = 0;
  let postgresWorkspaceReads = 0;
  let redisChannelLeaseReads = 0;
  const samples: number[] = [];
  const runChannel = async (id: number) => {
    const sessionId = `synthetic-session-${id}`;
    const userId = `synthetic-user-${id}`;
    const machineId = `synthetic-machine-${id}`;
    const authorized = createGatewayChannelLeaseGuard({
      sessionId,
      userId,
      expectedMachineId: machineId,
      expectedRuntimeBackend: 'WINDOWS_NATIVE',
      cacheMs: 0,
      readBrowser: async () => {
        redisBrowserReads++;
        return JSON.stringify({ sessionId, userId });
      },
      readWorkspace: async () => {
        postgresWorkspaceReads++;
        return { renterId: userId, machineId, runtimeBackend: 'WINDOWS_NATIVE',
          expiresAt: new Date(Date.now() + 60_000) };
      },
    });
    for (let frame = 0; frame < fps; frame++) {
      // The production native pump also checks wsChannelKey existence for each frame.
      redisChannelLeaseReads++;
      const started = performance.now();
      assert.equal(await authorized(), true);
      samples.push(performance.now() - started);
    }
  };
  await Promise.all(Array.from({length: channels}, (_, id) => runChannel(id)));
  const expected = fps * channels;
  assert.equal(redisBrowserReads, expected);
  assert.equal(postgresWorkspaceReads, expected);
  assert.equal(redisChannelLeaseReads, expected);
  samples.sort((a, b) => a - b);
  const result = {
    kind: 'synthetic-in-memory-not-production-SLO',
    fps, channels, frames: expected, redisBrowserReads,
    postgresWorkspaceReads, redisChannelLeaseReads,
    p50Ms: percentile(samples, 0.50),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  };
  assert.ok(result.p50Ms >= 0 && result.p99Ms >= result.p95Ms);
  console.log('STAGE4_NATIVE_AUTH_SYNTHETIC_LOAD ' + JSON.stringify(result));
  return result;
}

test('30/60 FPS over 1/4/8 native channels revalidates every frame, with p50/p95/p99 metrics', async () => {
  for (const fps of [30, 60] as const) {
    for (const channels of [1, 4, 8]) {
      await syntheticLoad(fps, channels);
    }
  }
});

test('30/60 FPS over 1/4/8 channels uses zero PostgreSQL reads while generation leases are hot',async()=>{
  for(const fps of [30,60] as const)for(const channels of [1,4,8])await syntheticGenerationLoad(fps,channels);
});

test('a STOP tombstone wins when a hot-path generation was read before its delayed enqueue',async()=>{
  const sessionId='stop-race',machineId='machine',channelId='channel';
  const authorities=new Map([[authorityKey(sessionId),authorityId(42)]]);
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),unblock=new Promise<void>(resolve=>{release=resolve;});
  let blocked=true,postgresReads=0;
  const redis=generationRedis(authorities,async()=>{if(blocked){blocked=false;enter();await unblock;}});
  const db={workspaceSession:{findFirst:async()=>{postgresReads++;return null;}}};
  const pending=acceptGatewayFrame({db:db as never,redis:redis as never,...activeFrame(sessionId,machineId,channelId)});
  await entered;
  await revokeGatewayAuthority(redis as never,sessionId);
  release();
  assert.equal((await pending).enqueued,-2);
  assert.match(authorities.get(authorityKey(sessionId))??'',/^revoked:/);
  assert.equal(postgresReads,0,'the stale hot-path request must not fall back to PostgreSQL after STOP');
});

test('an expired authority lease revalidates once and PostgreSQL failure cannot renew it',async()=>{
  const sessionId='renewal',machineId='machine',channelId='channel',receipt=authorityId(77);
  const authorities=new Map<string,string>();
  const redis=generationRedis(authorities);let postgresReads=0,postgresDown=false;
  const db={workspaceSession:{findFirst:async()=>{postgresReads++;if(postgresDown)throw new Error('postgres_down');return {
    startedAt:new Date(),expiresAt:new Date(Date.now()+60_000),booking:{workspaceActivatedAt:new Date(),status:'ACTIVE'},gatewayAcceptance:{id:receipt},
  };}}};
  const request={db:db as never,redis:redis as never,...activeFrame(sessionId,machineId,channelId)};
  assert.equal((await acceptGatewayFrame(request)).enqueued,1);assert.equal(postgresReads,1);
  assert.equal((await acceptGatewayFrame(request)).enqueued,1);assert.equal(postgresReads,1,'hot lease must avoid another DB read');
  authorities.delete(authorityKey(sessionId));postgresDown=true;
  await assert.rejects(acceptGatewayFrame(request),/postgres_down/);
  assert.equal(authorities.has(authorityKey(sessionId)),false,'a failed renewal must not recreate authority');
});

test('lease expiry between hot GET and enqueue renews safely instead of dropping the channel',async()=>{
  const sessionId='mid-eval-expiry',machineId='machine',channelId='channel',receipt=authorityId(88);
  const key=authorityKey(sessionId),authorities=new Map([[key,receipt]]);
  let expireOnFirstEnqueue=true,postgresReads=0;
  const redis=generationRedis(authorities,async()=>{
    if(expireOnFirstEnqueue){expireOnFirstEnqueue=false;authorities.delete(key);}
  });
  const db={workspaceSession:{findFirst:async()=>{postgresReads++;return {
    startedAt:new Date(),expiresAt:new Date(Date.now()+60_000),booking:{workspaceActivatedAt:new Date(),status:'ACTIVE'},gatewayAcceptance:{id:receipt},
  };}}};
  const accepted=await acceptGatewayFrame({db:db as never,redis:redis as never,...activeFrame(sessionId,machineId,channelId)});
  assert.equal(accepted.enqueued,1);
  assert.equal(postgresReads,1,'only the expired boundary falls back to PostgreSQL');
  assert.equal(authorities.get(key),receipt,'the same durable receipt is restored by CAS');
});

test('a Redis read outage and PostgreSQL read outage each terminate an independent native channel', async () => {
  for(const store of ['redis','postgres']) {
    let down=false;
    const guard=createGatewayChannelLeaseGuard({sessionId:'s',userId:'u',cacheMs:0,
      readBrowser:async()=>{if(down&&store==='redis')throw new Error('redis outage');return JSON.stringify({sessionId:'s',userId:'u'});},
      readWorkspace:async()=>{if(down&&store==='postgres')throw new Error('postgres outage');return {renterId:'u',expiresAt:new Date(Date.now()+60000)};},
    });
    assert.equal(await guard(),true);
    down=true;assert.equal(await guard(),false,store);
    down=false;assert.equal(await guard(),false,'old channel remains revoked after recovery');
  }
});

test('authorization timeout denies and does not keep a positive cached grant', async () => {
  const sessionId = 's', userId = 'u';
  let blocked = false;
  const guard = createGatewayChannelLeaseGuard({
    sessionId, userId, cacheMs: 0, timeoutMs: 10,
    readBrowser: async () => {
      if (blocked) return new Promise<string | null>(() => {});
      return JSON.stringify({ sessionId, userId });
    },
    readWorkspace: async () => ({ renterId: userId, expiresAt: new Date(Date.now() + 60_000) }),
  });
  assert.equal(await guard(), true);
  blocked = true;
  assert.equal(await guard(), false, 'a blocked Redis read must time out fail closed');
  blocked = false;
  assert.equal(await guard(), false, 'timeout permanently revokes this channel even after network recovery');
});

test('input backpressure rejects excessive queued native frames without allocating unbounded bytes', () => {
  const budget = new BrowserPendingBudget();
  assert.equal(budget.tryAcquire(WS_BROWSER_PENDING_MAX_BYTES), true);
  assert.equal(budget.tryAcquire(32), false);
  budget.release(WS_BROWSER_PENDING_MAX_BYTES);
  assert.deepEqual(budget.snapshot(), { items: 0, bytes: 0 });
});
