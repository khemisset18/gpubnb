import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.REDIS_URL ??= 'redis://127.0.0.1:1';
process.env.SESSION_SECRET ??= 'offline-preflight-session-secret-0123456789';
process.env.INTERNAL_SERVICE_TOKEN ??= 'offline-preflight-service-secret-0123456789';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';
const { config } = await import('../src/config.js');
const { registerDesktopWorkspaceRoutes } = await import('../src/desktop-workspace-routes.js');

const host = () => ({id:'private-listing', hourlyLamports:3600n,
  machine:{id:'private-machine', operatingSystem:'Windows 11', operational:'AVAILABLE', lastHeartbeatAt:new Date(),
    nativeDesktopStreamingAvailable:true, lastCounter:BigInt(21),
    nativeDesktopStreamingGpuUuid:'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a'},
  accelerators:[{accelerator:{hardwareUuid:'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a',
    vendor:'NVIDIA', moderationStatus:'CLEAR', status:'AVAILABLE'}}]});

async function fixture(run: (f: {app: ReturnType<typeof Fastify>; state: any; headers: Record<string,string>}) => Promise<void>) {
  const original={bypass:config.BETA_TEST_DEV_BYPASS,escrow:config.ESCROW_PROGRAM_ID};
  config.BETA_TEST_DEV_BYPASS='true';config.ESCROW_PROGRAM_ID='NOT_DEPLOYED_YET';
  const state={authenticated:true,reads:0,candidates:[] as any[], listingReads:0,firstReadOnly:false};
  const db={gpuListing:{findMany:async()=>{state.reads++;state.listingReads++;return state.firstReadOnly&&state.listingReads===1?[host()]:state.candidates;}},
    booking:{count:async()=>{state.reads++;return 0;},findFirst:async()=>{state.reads++;return null;}}} as unknown as PrismaClient;
  // Deliberately no create/update/delete/transaction method: any write is a test failure.
  const redis={get:async()=>state.authenticated?JSON.stringify({userId:'renter',wallet:'',createdAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()}):null,
    del:async()=>1,set:async()=>'OK'} as unknown as Redis;
  const app=Fastify();await app.register(cookie);registerDesktopWorkspaceRoutes(app,db,redis);
  try {await run({app,state,headers:{cookie:`${config.SESSION_COOKIE_NAME}=offline-fixture-token`}});}
  finally {await app.close();config.BETA_TEST_DEV_BYPASS=original.bypass;config.ESCROW_PROGRAM_ID=original.escrow;}
}

test('actual private GET and POST refuse absent/expired authentication before any DB read',async()=>fixture(async({app,state,headers})=>{
  for(const path of ['/qualification/windows-native/preflight','/qualification/windows-native/booking']){
    const method=path.endsWith('booking')?'POST':'GET';
    assert.equal((await app.inject({method,url:path})).statusCode,401);
    state.authenticated=false;assert.equal((await app.inject({method,url:path,headers})).statusCode,401);
  }
  assert.equal(state.reads,0);
}));

for(const mode of ['bypass-disabled','real-escrow'])test(`direct POST cannot bypass private mode: ${mode}`,async()=>fixture(async({app,state,headers})=>{
  if(mode==='bypass-disabled')config.BETA_TEST_DEV_BYPASS='false';else config.ESCROW_PROGRAM_ID='11111111111111111111111111111111';
  const get=await app.inject({method:'GET',url:'/qualification/windows-native/preflight',headers});
  assert.equal(get.json().privateNoPaymentMode,false);assert.equal(get.json().allowed,false);
  const post=await app.inject({method:'POST',url:'/qualification/windows-native/booking',headers});
  assert.equal(post.statusCode,409);assert.equal(post.json().error,'windows_native_qualification_disabled');
  assert.equal(state.reads,0);
}));

test('positive authenticated preflight is read-only and does not reserve or charge',async()=>fixture(async({app,state,headers})=>{
  state.candidates=[host()];
  const response=await app.inject({method:'GET',url:'/qualification/windows-native/preflight',headers});
  assert.equal(response.statusCode,200);assert.equal(response.json().allowed,true);
  assert.equal(response.headers['cache-control'],'no-store');assert.equal(state.reads,2);
}));

test('stale positive preflight cannot force a POST after the host becomes unavailable',async()=>fixture(async({app,state,headers})=>{
  state.firstReadOnly=true;
  assert.equal((await app.inject({method:'GET',url:'/qualification/windows-native/preflight',headers})).json().allowed,true);
  const refused=await app.inject({method:'POST',url:'/qualification/windows-native/booking',headers});
  assert.equal(refused.statusCode,409);assert.ok(refused.json().error);
}));
