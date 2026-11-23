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
const PRIVATE_CONSOLE_SHA='f664a07ec500c57bf9a508838f51b7c0305ba92d';

function usePrivateConsoleProof(state:{consoleProof:boolean}):()=>void {
  const keys=['GPUBNB_PRIVATE_CONSOLE_QUALIFICATION','GPUBNB_PRIVATE_CONSOLE_AGENT_COMMIT',
    'GPUBNB_RELEASE_SHA','BETA_TEST_DEV_BYPASS','ESCROW_PROGRAM_ID'] as const;
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]])) as Record<typeof keys[number],string|undefined>;
  process.env.GPUBNB_PRIVATE_CONSOLE_QUALIFICATION='true';
  process.env.GPUBNB_PRIVATE_CONSOLE_AGENT_COMMIT=PRIVATE_CONSOLE_SHA;
  process.env.GPUBNB_RELEASE_SHA=PRIVATE_CONSOLE_SHA;
  process.env.BETA_TEST_DEV_BYPASS='true';
  process.env.ESCROW_PROGRAM_ID='NOT_DEPLOYED_YET';
  state.consoleProof=true;
  return ()=>{for(const key of keys){const value=previous[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}};
}

const host = () => ({id:'private-listing', hourlyLamports:3600n,
  machine:{id:'private-machine', ownerId:'renter', operatingSystem:'Windows 11', operational:'AVAILABLE', lastHeartbeatAt:new Date(Date.now()-1_000),
    nativeDesktopStreamingAvailable:true, lastCounter:BigInt(21),
    nativeDesktopStreamingGpuUuid:'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a'},
  accelerators:[{accelerator:{hardwareUuid:'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a',
    vendor:'NVIDIA', moderationStatus:'CLEAR', status:'AVAILABLE'}}]});

async function fixture(run: (f: {app: ReturnType<typeof Fastify>; state: any; headers: Record<string,string>}) => Promise<void>) {
  const original={bypass:config.BETA_TEST_DEV_BYPASS,escrow:config.ESCROW_PROGRAM_ID,
    privateGamingAttempt:config.WINDOWS_NATIVE_PRIVATE_GAMING_TEST_ATTEMPT_ENABLED,
    commercialRentals:config.WINDOWS_NATIVE_RENTALS_ENABLED};
  config.BETA_TEST_DEV_BYPASS='true';config.ESCROW_PROGRAM_ID='NOT_DEPLOYED_YET';
  config.WINDOWS_NATIVE_PRIVATE_GAMING_TEST_ATTEMPT_ENABLED='false';config.WINDOWS_NATIVE_RENTALS_ENABLED='false';
  const state={authenticated:true,reads:0,candidates:[] as any[], listingReads:0,firstReadOnly:false,session:null as any,redisWrites:0,consoleProof:false};
  const db={gpuListing:{findMany:async()=>{state.reads++;state.listingReads++;return state.firstReadOnly&&state.listingReads===1?[host()]:state.candidates;}},
    booking:{count:async()=>{state.reads++;return 0;},findFirst:async()=>{state.reads++;return null;}},
    workspaceSession:{findFirst:async()=>state.session}} as unknown as PrismaClient;
  // Deliberately no create/update/delete/transaction method: any write is a test failure.
  const redis={get:async(key:string)=>{
      if(key==='private-console-proof:v1:private-machine'&&state.consoleProof){
        return JSON.stringify({gpuUuid:'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a',agentCommit:'f664a07ec500c57bf9a508838f51b7c0305ba92d',acceptedCounter:'21'});
      }
      return state.authenticated?JSON.stringify({userId:'renter',wallet:'',createdAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()}):null;
    },
    del:async()=>1,set:async()=>{state.redisWrites++;return 'OK';}} as unknown as Redis;
  const app=Fastify();await app.register(cookie);registerDesktopWorkspaceRoutes(app,db,redis);
  try {await run({app,state,headers:{cookie:`${config.SESSION_COOKIE_NAME}=offline-fixture-token`}});}
  finally {await app.close();config.BETA_TEST_DEV_BYPASS=original.bypass;config.ESCROW_PROGRAM_ID=original.escrow;
    config.WINDOWS_NATIVE_PRIVATE_GAMING_TEST_ATTEMPT_ENABLED=original.privateGamingAttempt;
    config.WINDOWS_NATIVE_RENTALS_ENABLED=original.commercialRentals;}
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

test('physically eligible preflight remains read-only but refuses unqualified browser audio',async()=>fixture(async({app,state,headers})=>{
  state.candidates=[host()];
  const response=await app.inject({method:'GET',url:'/qualification/windows-native/preflight',headers});
  assert.equal(response.statusCode,200);assert.equal(response.json().privateNoPaymentMode,true);
  assert.equal(response.json().allowed,false);assert.equal(response.json().hostReady,true);
  assert.equal(response.json().code,'windows_native_audio_not_qualified');
  assert.equal(response.headers['cache-control'],'no-store');assert.equal(state.reads,2);
}));

test('private Gaming is owner-bound, uses its own block reason and rejects direct booking/session bypasses',async()=>fixture(async({app,state,headers})=>{
  const restoreConsole=usePrivateConsoleProof(state);
  try {
  state.candidates=[host()];
  state.consoleProof=false;
  const fallback=await app.inject({method:'GET',url:'/qualification/windows-native/preflight?workspaceSlug=gaming',headers});
  assert.equal(fallback.json().allowed,false);
  assert.equal(fallback.json().code,'PRIVATE_WINDOWS_HOST_NOT_READY',
    'Gaming must not fall back to the legacy IddCx proof');
  state.consoleProof=true;
  const preflight=await app.inject({method:'GET',url:'/qualification/windows-native/preflight?workspaceSlug=gaming',headers});
  assert.equal(preflight.statusCode,200);assert.equal(preflight.json().privateNoPaymentMode,true);
  assert.equal(preflight.json().allowed,false);
  assert.equal(preflight.json().code,'windows_native_private_gaming_test_attempt_disabled');
  const readsBefore=state.reads;
  const booking=await app.inject({method:'POST',url:'/qualification/windows-native/booking',headers,
    payload:{workspaceSlug:'gaming'}});
  assert.equal(booking.statusCode,409);
  assert.equal(booking.json().error,'windows_native_private_gaming_test_attempt_disabled');
  const session=await app.inject({method:'POST',url:'/bookings/forged-booking/workspace/gaming?qualification=windows-native',headers});
  assert.equal(session.statusCode,409);
  assert.equal(session.json().error,'windows_native_private_gaming_test_attempt_disabled');
  assert.equal(state.reads,readsBefore,'unqualified Gaming must stop before booking or allocation lookups');
  assert.equal(state.redisWrites,0,'unqualified Gaming cannot create access or session grants');
  } finally {restoreConsole();}
}));

test('explicit private Gaming attempt permits only an owner test and never records qualification or public eligibility',async()=>fixture(async({app,state,headers})=>{
  const restoreConsole=usePrivateConsoleProof(state);
  try {
  config.WINDOWS_NATIVE_PRIVATE_GAMING_TEST_ATTEMPT_ENABLED='true';
  state.candidates=[host()];
  const gaming=await app.inject({method:'GET',url:'/qualification/windows-native/preflight?workspaceSlug=gaming',headers});
  assert.equal(gaming.statusCode,200);
  assert.equal(gaming.json().privateNoPaymentMode,true);
  assert.equal(gaming.json().allowed,true);
  assert.equal(gaming.json().testAttemptOnly,true);
  assert.equal(gaming.json().qualificationPassed,false);
  assert.equal(gaming.json().publicEligible,false);
  const desktop=await app.inject({method:'GET',url:'/qualification/windows-native/preflight?workspaceSlug=cloud-desktop',headers});
  assert.equal(desktop.json().allowed,false);
  assert.equal(desktop.json().code,'windows_native_audio_not_qualified');
  assert.equal(state.redisWrites,0);
  } finally {restoreConsole();}
}));

test('private Gaming attempt is rejected whenever commercial Windows rentals are enabled',async()=>fixture(async({app,state,headers})=>{
  const restoreConsole=usePrivateConsoleProof(state);
  try {
  config.WINDOWS_NATIVE_PRIVATE_GAMING_TEST_ATTEMPT_ENABLED='true';
  config.WINDOWS_NATIVE_RENTALS_ENABLED='true';
  state.candidates=[host()];
  const response=await app.inject({method:'GET',url:'/qualification/windows-native/preflight?workspaceSlug=gaming',headers});
  assert.equal(response.json().allowed,false);
  assert.equal(response.json().code,'windows_native_private_gaming_test_attempt_disabled');
  assert.equal(state.redisWrites,0);
  } finally {restoreConsole();}
}));

test('Gaming session status and access require the private attempt gate and never report public eligibility',async()=>fixture(async({app,state,headers})=>{
  state.session={id:'gaming-session',renterId:'renter',status:'READY',runtimeBackend:'WINDOWS_NATIVE',expiresAt:new Date(Date.now()+60_000),
    preparationProgress:100,preparationStep:'CONNECTION_READY',preparationAttempts:1,preparationRequestedAt:new Date(),
    preparationStartedAt:new Date(),preparationCompletedAt:new Date(),endedAt:null,updatedAt:new Date(),
    connectionMetadata:{gatewayPath:'/workspace-gateway/gaming-session/native-stream'},gatewayLastSeenAt:new Date(),job:null,
    machine:{gpuModel:'NVIDIA test',vramMiB:8192,connectivity:'ONLINE',operational:'AVAILABLE',moderationStatus:'CLEAR',lastHeartbeatAt:new Date()},
    booking:{status:'FUNDED',startsAt:new Date(),endsAt:new Date(Date.now()+60_000)},
    machineWorkspace:{workspace:{slug:'gaming',name:'Gaming'}},events:[{id:'gaming-attempt',action:'WINDOWS_NATIVE_GAMING_SESSION_REQUESTED'}]};
  const blocked=await app.inject({method:'GET',url:'/bookings/gaming-booking/workspace/gaming/status',headers});
  assert.equal(blocked.json().status,'BLOCKED');assert.equal(blocked.json().canOpen,false);
  assert.equal(blocked.json().blockedReason,'WINDOWS_NATIVE_PRIVATE_GAMING_TEST_ATTEMPT_DISABLED');
  const blockedAccess=await app.inject({method:'POST',url:'/bookings/gaming-booking/workspace/gaming/access',headers});
  assert.equal(blockedAccess.statusCode,409);
  assert.equal(blockedAccess.json().error,'windows_native_private_gaming_test_attempt_disabled');
  assert.equal(state.redisWrites,0);

  config.WINDOWS_NATIVE_PRIVATE_GAMING_TEST_ATTEMPT_ENABLED='true';
  const allowed=await app.inject({method:'GET',url:'/bookings/gaming-booking/workspace/gaming/status',headers});
  assert.equal(allowed.json().status,'READY');assert.equal(allowed.json().canOpen,true);
  assert.equal(allowed.json().testAttemptOnly,true);assert.equal(allowed.json().qualificationPassed,false);
  assert.equal(allowed.json().publicEligible,false);
  const access=await app.inject({method:'POST',url:'/bookings/gaming-booking/workspace/gaming/access',headers});
  assert.equal(access.statusCode,200);assert.match(access.json().openPath,/\?grant=/);
  assert.equal(state.redisWrites,1);
}));

test('private qualification rejects unsupported workspace slugs before database access',async()=>fixture(async({app,state,headers})=>{
  const preflight=await app.inject({method:'GET',url:'/qualification/windows-native/preflight?workspaceSlug=creator',headers});
  assert.equal(preflight.statusCode,400);assert.equal(preflight.json().error,'unsupported_private_qualification_workspace');
  const booking=await app.inject({method:'POST',url:'/qualification/windows-native/booking',headers,
    payload:{workspaceSlug:'creator'}});
  assert.equal(booking.statusCode,400);assert.equal(booking.json().error,'unsupported_private_qualification_workspace');
  assert.equal(state.reads,0);
}));

test('direct booking and qualification-session requests cannot bypass the audio qualification gate',async()=>fixture(async({app,state,headers})=>{
  state.candidates=[host()];
  const preflight=await app.inject({method:'GET',url:'/qualification/windows-native/preflight',headers});
  assert.equal(preflight.json().allowed,false);
  const readsBefore=state.reads;
  const refused=await app.inject({method:'POST',url:'/qualification/windows-native/booking',headers});
  assert.equal(refused.statusCode,409);assert.equal(refused.json().error,'windows_native_audio_not_qualified');
  const session=await app.inject({method:'POST',url:'/bookings/forged-booking/workspace/cloud-desktop?qualification=windows-native',headers});
  assert.equal(session.statusCode,409);assert.equal(session.json().error,'windows_native_audio_not_qualified');
  assert.equal(state.reads,readsBefore,'unsupported requests must be rejected before booking or allocation lookups');
  assert.equal(state.redisWrites,0,'unsupported requests must not create access or session grants');
}));

test('legacy private qualification sessions cannot become openable or receive an access grant',async()=>fixture(async({app,state,headers})=>{
  state.session={id:'legacy-session',status:'READY',runtimeBackend:'WINDOWS_NATIVE',expiresAt:new Date(Date.now()+60_000),
    preparationProgress:100,preparationStep:'WAITING_FOR_INTERACTIVE_CONNECTION',preparationAttempts:1,
    preparationRequestedAt:new Date(),preparationStartedAt:new Date(),preparationCompletedAt:new Date(),endedAt:null,updatedAt:new Date(),
    connectionMetadata:{gatewayPath:'/workspace-gateway/legacy-session'},gatewayLastSeenAt:new Date(),job:null,
    machine:{gpuModel:'NVIDIA test',vramMiB:8192,connectivity:'ONLINE',operational:'AVAILABLE',moderationStatus:'CLEAR',lastHeartbeatAt:new Date()},
    booking:{status:'ACTIVE',startsAt:new Date(),endsAt:new Date(Date.now()+60_000)},
    machineWorkspace:{workspace:{slug:'cloud-desktop',name:'Cloud Desktop'}},events:[{id:'qualification-event'}]};
  const status=await app.inject({method:'GET',url:'/bookings/legacy-booking/workspace/cloud-desktop/status',headers});
  assert.equal(status.statusCode,200);assert.equal(status.json().status,'BLOCKED');assert.equal(status.json().canOpen,false);
  assert.equal(status.json().blockedReason,'WINDOWS_NATIVE_AUDIO_NOT_QUALIFIED');
  const access=await app.inject({method:'POST',url:'/bookings/legacy-booking/workspace/cloud-desktop/access',headers});
  assert.equal(access.statusCode,409);assert.equal(access.json().error,'windows_native_audio_not_qualified');
  assert.equal(state.redisWrites,0);
}));
