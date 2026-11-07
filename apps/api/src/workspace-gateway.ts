import { createGatewayChannelLeaseGuard } from './workspace-gateway-channel-lease.js';
import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BookingStatus, JobStatus, MachineConnectivity, MachineOperational, ModerationStatus, PaymentStatus, Prisma, SessionTerminationReason, WorkspaceRuntimeBackend, WorkspaceSessionStatus, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import WebSocket from 'ws';
import { runBookingTransaction } from './booking-transaction-retry.js';
import { dataPlaneHostBootstrapEnabled, issueHostTunnelBootstrap, loadDataPlaneHostRuntimeConfig } from './data-plane-host-bootstrap.js';
import { verifyAgentRequest, verifyAgentRequestV2 } from './security.js';
import { consumeWorkspaceAccessGrant } from './workspace-access.js';
import { enterQuarantine } from './quarantine-service.js';
import { privateConsoleAgentCommit, privateConsoleDesiredFields } from './windows-native-private-console.js';
import { waitForGatewayQueueItem } from './gateway-queue.js';
import {
  browserGatewayFrameAllowed,
  gatewayRuntimeBackends,
  isWindowsNativeRuntime,
  upstreamGatewayFrameAllowed,
  windowsNativeUpgradeAllowed,
} from './windows-native-gateway-policy.js';
import {
  BrowserPendingBudget,
  WS_BROWSER_BACKPRESSURE_TIMEOUT_MS,
  WS_BROWSER_BUFFERED_HIGH_WATER_BYTES,
  WS_MACHINE_QUEUE_MAX_BYTES,
  WS_REDIS_INPUT_MAX_BYTES,
  isStrictBase64Payload,
  websocketDataToBuffer,
  websocketMessageIsBinary,
} from './workspace-gateway-transport.js';

const WebSocketServer=WebSocket.Server;
// Every workspace this gateway can actually run a persistent container+browser
// session for. Kept as a plain literal (not imported from
// machine-workspace-catalog's executableWorkspaceSlugs) because that list also
// includes 'compute', which never runs through this gateway at all (it's a
// one-shot batch job - see agent/gpubnb_agent/runner.py's GPU_PROOF path).
const GATEWAY_WORKSPACE_SLUGS:string[]=['developer','data','ai','video','audio','api','mobile','security-lab','cloud-desktop','creator','cad','gaming'];
const GATEWAY_COOKIE='gpubnb_workspace';
const SESSION_TTL_SECONDS=3600;
const INTERACTIVE_CONNECT_TIMEOUT_SECONDS=15*60;
const RESPONSE_TIMEOUT_MS=30_000;
const WS_UPSTREAM_OPEN_TIMEOUT_MS=15_000;
const WS_HEALTH_PATH='/ws-health';
const WS_MAX_FRAME_BYTES=4*1024*1024;
const WS_MAX_BASE64_BYTES=Math.ceil(WS_MAX_FRAME_BYTES/3)*4;
const AGENT_TUNNEL_RATE_LIMIT_PER_MINUTE=6000;
const AGENT_RESPONSE_RATE_LIMIT_PER_MINUTE=1200;
const AGENT_NEXT_BATCH_MAX_ITEMS=64;
const AGENT_NEXT_BATCH_MAX_JSON_BYTES=16*1024*1024;
const AGENT_WS_FRAME_BATCH_MAX_ITEMS=32;
const AGENT_WS_FRAME_BATCH_MAX_BASE64_BYTES=8*1024*1024;
const WS_FRAME_DEDUPE_TTL_SECONDS=180;
const MACHINE_QUEUE_TTL_SECONDS=120;
const MACHINE_QUEUE_MAX_ITEMS=512;
const WS_INPUT_TTL_SECONDS=120;
const WS_INPUT_MAX_ITEMS=512;
// The agent reads at most 10 MiB from code-server. Base64 expands that by
// one third; 15 MiB leaves bounded room for the signed JSON envelope/headers
// without weakening the API-wide 128 KiB request limit.
const MAX_AGENT_RELAY_BODY_BYTES=15*1024*1024;
const SAFE_RESPONSE_HEADERS=new Set(['content-type','cache-control','etag','last-modified','content-disposition','content-encoding','vary','location']);

const ENQUEUE_BOUNDED_LIST_SCRIPT=`
local count = redis.call('LLEN', KEYS[1])
local currentBytes = tonumber(redis.call('GET', KEYS[2]) or '0')
local itemBytes = tonumber(ARGV[3])
if count >= tonumber(ARGV[4]) or currentBytes + itemBytes > tonumber(ARGV[5]) then
  return 0
end
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], currentBytes + itemBytes, 'EX', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

const ACCOUNT_DEQUEUED_LIST_BYTES_SCRIPT=`
local currentBytes = tonumber(redis.call('GET', KEYS[1]) or '0')
local nextBytes = currentBytes - tonumber(ARGV[1])
if nextBytes <= 0 then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('SET', KEYS[1], nextBytes, 'EX', ARGV[2])
return nextBytes
`;

const ENQUEUE_DEDUPED_WS_FRAME_SCRIPT=`
-- Fence the channel binding in the same Redis transaction as the enqueue.
-- A revoked/replaced lease must never be allowed to add a new buffered frame.
if redis.call('GET', KEYS[4]) ~= ARGV[7] then
  return -2
end
-- On native paths, deletion of the browser cookie is a revocation as well.
if ARGV[8] == '1' and redis.call('EXISTS', KEYS[5]) ~= 1 then
  return -2
end
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
local count = redis.call('LLEN', KEYS[2])
local currentBytes = tonumber(redis.call('GET', KEYS[3]) or '0')
local itemBytes = tonumber(ARGV[4])
if count >= tonumber(ARGV[5]) or currentBytes + itemBytes > tonumber(ARGV[6]) then
  return -1
end
local owner = ARGV[9] or '1'
if redis.call('SET', KEYS[1], owner, 'EX', ARGV[1], 'NX') then
  redis.call('LPUSH', KEYS[2], ARGV[3])
  redis.call('SET', KEYS[3], currentBytes + itemBytes, 'EX', ARGV[2])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  return 1
end
return 0
`;

const ENQUEUE_BOUND_WS_FRAME_SCRIPT=`
-- The binding and enqueue are linearized by Redis (no check-then-use window).
if redis.call('GET', KEYS[3]) ~= ARGV[6] then
  return -2
end
if ARGV[7] == '1' and redis.call('EXISTS', KEYS[4]) ~= 1 then
  return -2
end
local count = redis.call('LLEN', KEYS[1])
local currentBytes = tonumber(redis.call('GET', KEYS[2]) or '0')
local itemBytes = tonumber(ARGV[3])
if count >= tonumber(ARGV[4]) or currentBytes + itemBytes > tonumber(ARGV[5]) then
  return -1
end
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], currentBytes + itemBytes, 'EX', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

const NATIVE_DELIVERY_FENCE_SCRIPT=`
-- Final Redis read after the DB check: both immutable channel binding and
-- browser identity must still match the upgrade. This does not make the DB
-- and Redis a joint transaction or recall bytes already sent to a socket.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
return 1
`;

const COMPENSATE_GATEWAY_ACCEPTANCE_SCRIPT=`
-- Remove only the exact payload owned by this failed DB transaction. A retry
-- with another receipt must never have its marker or byte accounting removed.
local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])
if removed > 0 then
  local bytes = tonumber(redis.call('GET', KEYS[2]) or '0') - tonumber(ARGV[2])
  if bytes <= 0 then redis.call('DEL', KEYS[2])
  else redis.call('SET', KEYS[2], bytes, 'KEEPTTL') end
end
if ARGV[3] == '1' and redis.call('GET', KEYS[3]) == ARGV[4] then
  redis.call('DEL', KEYS[3])
end
return removed
`;

const ENQUEUE_BOUND_MACHINE_RELAY_SCRIPT=`
-- Browser-to-Agent native send/open is atomic with the current channel grant.
-- A stale positive result from an in-flight DB read cannot requeue data after
-- an already committed Redis channel or browser cookie revocation.
if redis.call('GET', KEYS[3]) ~= ARGV[6] then
  return -2
end
if redis.call('EXISTS', KEYS[4]) ~= 1 then
  return -2
end
local count = redis.call('LLEN', KEYS[1])
local currentBytes = tonumber(redis.call('GET', KEYS[2]) or '0')
local itemBytes = tonumber(ARGV[3])
if count >= tonumber(ARGV[4]) or currentBytes + itemBytes > tonumber(ARGV[5]) then
  return -1
end
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], currentBytes + itemBytes, 'EX', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

type RelayRequest={id:string;sessionId:string;kind:'http'|'ws_open'|'ws_send'|'ws_close';nativeChannelBinding?:string;method?:string;path?:string;headers?:Record<string,string>;bodyBase64?:string;channelId?:string;dataBase64?:string;binary?:boolean};
type RelayResponse={status:number;headers?:Record<string,string>;bodyBase64?:string;error?:string};
type GatewayChannelBinding={sessionId:string;machineId:string;browserSessionKey:string;runtimeBackend:WorkspaceRuntimeBackend};
type AgentWsFrame={frameId?:string;channelId?:string;dataBase64?:string;binary?:boolean;close?:boolean};
type UpgradeStatus=401|403|404|409|500;

const gatewaySessionKey=(token:string)=>`workspace-gateway-session:${crypto.createHash('sha256').update(token).digest('hex')}`;
const machineQueue=(machineId:string)=>`workspace-gateway:machine:${machineId}`;
const machineQueueBytesKey=(machineId:string)=>`workspace-gateway:machine-bytes:${machineId}`;
const responseKey=(id:string)=>`workspace-gateway:response:${id}`;
const wsInputKey=(channelId:string)=>`workspace-gateway:ws-input:${channelId}`;
const wsInputBytesKey=(channelId:string)=>`workspace-gateway:ws-input-bytes:${channelId}`;
const wsChannelKey=(channelId:string)=>`workspace-gateway:ws-channel:${channelId}`;
const wsUpstreamReadyKey=(channelId:string)=>`workspace-gateway:ws-upstream-ready:${channelId}`;
const wsSessionActivatedKey=(sessionId:string)=>`workspace-gateway:ws-session-activated:${sessionId}`;
const wsFrameSeenKey=(machineId:string,frameId:string)=>`workspace-gateway:ws-frame-seen:${machineId}:${frameId}`;

function parseCookie(header:string|undefined,name:string){for(const part of (header||'').split(';')){const [key,...rest]=part.trim().split('=');if(key===name){try{return decodeURIComponent(rest.join('='));}catch{return null;}}}return null;}
function safePath(value:string){return value.startsWith('/')&&!value.includes('..')&&value.length<=4096;}
function relayHeaders(headers:Record<string,unknown>){const allowed=['accept','accept-language','accept-encoding','content-type','if-none-match','if-modified-since','range','user-agent','sec-websocket-protocol'];return Object.fromEntries(allowed.flatMap(name=>{const value=headers[name];return typeof value==='string'?[[name,value]]:[]}));}
async function waitJson(redis:Redis,key:string,timeoutMs=RESPONSE_TIMEOUT_MS){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const raw=await redis.getdel(key);if(raw)return JSON.parse(raw) as RelayResponse;await new Promise(resolve=>setTimeout(resolve,30));}return null;}

async function enqueueBoundedList(redis:Redis,listKey:string,bytesKey:string,payload:string,ttlSeconds:number,maxItems:number,maxBytes:number):Promise<boolean>{
  const size=Buffer.byteLength(payload,'utf8');
  if(size>maxBytes)return false;
  const accepted=Number(await redis.eval(ENQUEUE_BOUNDED_LIST_SCRIPT,2,listKey,bytesKey,payload,String(ttlSeconds),String(size),String(maxItems),String(maxBytes)));
  return accepted===1;
}

async function enqueueBoundNativeMachineRelay(redis:Redis,machineId:string,channelId:string,expectedBinding:string,browserSessionKey:string,relay:RelayRequest):Promise<boolean>{
  // Internal fencing metadata is removed before returning work to the Agent.
  const payload=JSON.stringify({...relay,nativeChannelBinding:expectedBinding});
  const accepted=Number(await redis.eval(ENQUEUE_BOUND_MACHINE_RELAY_SCRIPT,4,
    machineQueue(machineId),machineQueueBytesKey(machineId),wsChannelKey(channelId),browserSessionKey,
    payload,String(MACHINE_QUEUE_TTL_SECONDS),String(Buffer.byteLength(payload,'utf8')),
    String(MACHINE_QUEUE_MAX_ITEMS),String(WS_MACHINE_QUEUE_MAX_BYTES),expectedBinding));
  return accepted===1;
}

async function enqueueAuthorizedNativeMachineRelay(
  db:PrismaClient,redis:Redis,sessionId:string,userId:string,machineId:string,
  runtimeBackend:WorkspaceRuntimeBackend,channelId:string,expectedBinding:string,
  browserSessionKey:string,relay:RelayRequest,
):Promise<boolean>{
  return withNativeGatewaySessionFence(db,sessionId,machineId,userId,runtimeBackend,
    async isActive=>{
      const accepted=await enqueueBoundNativeMachineRelay(redis,machineId,channelId,expectedBinding,browserSessionKey,relay);
      return isActive()&&accepted;
    });
}

async function accountDequeuedBytes(redis:Redis,bytesKey:string,payload:string,ttlSeconds:number):Promise<void>{
  const size=Buffer.byteLength(payload,'utf8');
  await redis.eval(ACCOUNT_DEQUEUED_LIST_BYTES_SCRIPT,1,bytesKey,String(size),String(ttlSeconds));
}

async function enqueueMachineRelay(redis:Redis,machineId:string,relay:RelayRequest):Promise<boolean>{
  return enqueueBoundedList(redis,machineQueue(machineId),machineQueueBytesKey(machineId),JSON.stringify(relay),MACHINE_QUEUE_TTL_SECONDS,MACHINE_QUEUE_MAX_ITEMS,WS_MACHINE_QUEUE_MAX_BYTES);
}

export function websocketUpgradeRejection(status:UpgradeStatus,error:string):Buffer{
  const statusText:Record<UpgradeStatus,string>={401:'Unauthorized',403:'Forbidden',404:'Not Found',409:'Conflict',500:'Internal Server Error'};
  const body=JSON.stringify({error});
  return Buffer.from(`HTTP/1.1 ${status} ${statusText[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,'utf8');
}

function rejectWebSocketUpgrade(socket:Socket,status:UpgradeStatus,error:string):void{
  if(socket.destroyed)return;
  socket.end(websocketUpgradeRejection(status,error));
}

async function authenticateAgent(db:PrismaClient,redis:Redis,machineId:string,request:FastifyRequest,routePath:string,withBody=false){
  const machine=await db.machine.findUnique({where:{id:machineId},select:{agentPublicKey:true,keyRevokedAt:true,moderationStatus:true}});
  if(!machine||machine.keyRevokedAt||machine.moderationStatus!==ModerationStatus.CLEAR)return false;
  const versionHeader=request.headers['x-agent-signature-version'];
  const signatureVersion=Array.isArray(versionHeader)?versionHeader[0]:versionHeader;
  if(signatureVersion==='2'){
    const bodyBytes=request.rawBody??Buffer.alloc(0);
    return verifyAgentRequestV2(redis,machineId,machine.agentPublicKey,request.method,routePath,bodyBytes,{timestamp:request.headers['x-agent-timestamp'],nonce:request.headers['x-agent-nonce'],bodySha256:request.headers['x-agent-body-sha256'],signature:request.headers['x-agent-signature-v2'],version:request.headers['x-agent-signature-version']});
  }
  if(withBody)return false;
  return verifyAgentRequest(redis,machineId,machine.agentPublicKey,request.method,routePath,request.headers['x-agent-timestamp'],request.headers['x-agent-signature']);
}
export async function activeGatewaySession(db:PrismaClient,sessionId:string){return db.workspaceSession.findFirst({where:{id:sessionId,runtimeBackend:{in:gatewayRuntimeBackends()},status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},expiresAt:{gt:new Date()},machine:{connectivity:MachineConnectivity.ONLINE,moderationStatus:ModerationStatus.CLEAR},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,renterId:true,machineId:true,bookingId:true,jobId:true,status:true,expiresAt:true,runtimeBackend:true,connectionMetadata:true,machineWorkspace:{select:{workspace:{select:{slug:true}}}}}});}

class NativeGatewayFenceRollback extends Error {}

/**
 * Serialize a native channel operation with PostgreSQL session revocations.
 * Authority row locks remain held through the caller's final Redis fence and its
 * synchronous ws.send/enqueue admission point. A STOP update that wins first
 * is observed as inactive; if this operation wins first, STOP cannot commit
 * until it has reached that admission point. A frame admitted before STOP may
 * still be buffered by the local socket/TCP stack; TCP bytes already handed
 * off cannot be recalled. No extra API generation is needed for channel reuse:
 * each upgrade gets a new UUID binding, Agent channel identities are consumed,
 * and the native helper independently rotates its runtime/stream epochs.
 */
export async function withNativeGatewaySessionFence(
  db:PrismaClient,
  sessionId:string,
  machineId:string,
  userId:string,
  runtimeBackend:WorkspaceRuntimeBackend,
  operation:(isActive:()=>boolean,tx:Prisma.TransactionClient)=>Promise<boolean>,
  options:{lockSessionForMutation?:boolean}={},
):Promise<boolean>{
  if(!isWindowsNativeRuntime(runtimeBackend))return false;
  try{return await db.$transaction(async tx=>{
    // Keep the active-session predicate and row lock in one SQL round trip.
    // This is the same fail-closed predicate as activeGatewaySession(), with
    // the joined tables checked before the session row is admitted.
    const sessionLock=options.lockSessionForMutation?Prisma.raw('UPDATE'):Prisma.raw('SHARE');
    const locked=await tx.$queryRaw<Array<{id:string;machineId:string;renterId:string;runtimeBackend:WorkspaceRuntimeBackend;remainingMs:bigint}>>`
      SELECT ws."id",ws."machineId",ws."renterId",ws."runtimeBackend"::text AS "runtimeBackend",
        FLOOR(GREATEST(0,EXTRACT(EPOCH FROM (ws."expiresAt"-clock_timestamp()))*1000))::bigint AS "remainingMs"
      FROM "WorkspaceSession" AS ws
      JOIN "Machine" AS m ON m."id"=ws."machineId"
      JOIN "MachineWorkspace" AS mw ON mw."id"=ws."machineWorkspaceId"
      JOIN "WorkspaceDefinition" AS w ON w."id"=mw."workspaceId"
      WHERE ws."id"=${sessionId} AND ws."machineId"=${machineId}
        AND mw."machineId"=ws."machineId"
        AND ws."runtimeBackend"::text=${runtimeBackend}
        AND ws."status"::text IN ('READY','RUNNING')
        AND ws."expiresAt">clock_timestamp()
        AND m."connectivity"::text='ONLINE'
        AND m."moderationStatus"::text='CLEAR'
        AND w."slug" IN (${Prisma.join(GATEWAY_WORKSPACE_SLUGS)})
      FOR ${sessionLock} OF ws FOR SHARE OF m,mw,w
    `;
    if(locked.length!==1)return false;
    const row=locked[0]!;
    if(row.machineId!==machineId||row.renterId!==userId||row.runtimeBackend!==runtimeBackend)return false;
    const remainingMs=Number(row.remainingMs);
    if(!Number.isFinite(remainingMs)||remainingMs<=0)return false;
    const activeUntil=performance.now()+remainingMs;
    let operationActive=true;let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      // DB mutation callbacks must stay inside the transaction until all of
      // their writes finish; Prisma's transaction timeout bounds that work.
      // The shorter race is for Redis/socket admission callbacks only.
      const result=options.lockSessionForMutation
        ? await operation(()=>operationActive&&performance.now()<activeUntil,tx)
        : await Promise.race([
            operation(()=>operationActive&&performance.now()<activeUntil,tx),
            new Promise<boolean>(resolve=>{timer=setTimeout(()=>{operationActive=false;resolve(false);},4_000);}),
          ]);
      if(options.lockSessionForMutation&&!result)throw new NativeGatewayFenceRollback();
      return result;
    }finally{
      operationActive=false;
      if(timer!==undefined)clearTimeout(timer);
    }
  },{maxWait:5_000,timeout:5_000});}catch(error){if(error instanceof NativeGatewayFenceRollback)return false;throw error;}
}

/**
 * Publish a native revocation before waiting for the Agent/helper cleanup path.
 * WTS can change while an Agent HTTP batch is in flight; moving the session to
 * STOPPING under the same row lock makes every later frame/input fence fail.
 * Bytes already admitted to a socket/TCP buffer remain non-recallable.
 */
export async function markNativeGatewayRevocationStarted(
  db:PrismaClient,redis:Redis,sessionId:string,machineId:string,
):Promise<boolean>{
  const revoked=await db.$transaction(async tx=>{
    const locked=await tx.$queryRaw<Array<{id:string}>>`
      SELECT ws."id" FROM "WorkspaceSession" AS ws
      WHERE ws."id"=${sessionId} AND ws."machineId"=${machineId}
        AND ws."runtimeBackend"::text='WINDOWS_NATIVE'
      FOR UPDATE OF ws
    `;
    if(locked.length!==1)return false;
    const current=await tx.workspaceSession.findUnique({where:{id:sessionId},select:{status:true}});
    if(!current)return false;
    if(current.status===WorkspaceSessionStatus.READY||current.status===WorkspaceSessionStatus.RUNNING||current.status===WorkspaceSessionStatus.STOP_REQUESTED){
      const changed=await tx.workspaceSession.updateMany({
        where:{id:sessionId,machineId,runtimeBackend:WorkspaceRuntimeBackend.WINDOWS_NATIVE,status:current.status},
        data:{status:WorkspaceSessionStatus.STOPPING},
      });
      if(changed.count!==1)return false;
      await tx.workspaceSessionEvent.create({data:{sessionId,actorType:'AGENT',actorId:machineId,action:'NATIVE_GATEWAY_AUTHORITY_REVOKED'}});
      return true;
    }
    return current.status===WorkspaceSessionStatus.STOPPING||current.status===WorkspaceSessionStatus.COMPLETED||
      current.status===WorkspaceSessionStatus.FAILED||current.status===WorkspaceSessionStatus.CANCELLED||
      current.status===WorkspaceSessionStatus.TIMED_OUT||current.status===WorkspaceSessionStatus.QUARANTINED;
  },{maxWait:5_000,timeout:5_000});
  if(revoked)await redis.del(wsSessionActivatedKey(sessionId));
  return revoked;
}

// A successful enqueue is not a lasting input grant: STOP/cookie revocation
// can occur while a command is buffered in the shared machine queue.
type QueuedGatewayDecision={relay:RelayRequest|null;scope:'channel'|'session'};

export async function authorizeQueuedGatewayRelay(db:PrismaClient,redis:Redis,machineId:string,queued:RelayRequest,timeoutMs=5000):Promise<RelayRequest|null>{
  return (await decideQueuedGatewayRelay(db,redis,machineId,queued,timeoutMs)).relay;
}

async function decideQueuedGatewayRelay(db:PrismaClient,redis:Redis,machineId:string,queued:RelayRequest,timeoutMs=5000):Promise<QueuedGatewayDecision>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([
      validateQueuedGatewayRelay(db,redis,machineId,queued),
      new Promise<QueuedGatewayDecision>(resolve=>{timer=setTimeout(()=>resolve({relay:null,scope:'session'}),timeoutMs);}),
    ]);
  }catch{return {relay:null,scope:'session'};}
  finally{if(timer!==undefined)clearTimeout(timer);}
}

async function validateQueuedGatewayRelay(db:PrismaClient,redis:Redis,machineId:string,queued:RelayRequest):Promise<QueuedGatewayDecision>{
  const {nativeChannelBinding,...relay}=queued;
  const allow:QueuedGatewayDecision={relay,scope:'channel'};
  const denyChannel:QueuedGatewayDecision={relay:null,scope:'channel'};
  const denySession:QueuedGatewayDecision={relay:null,scope:'session'};
  if(relay.kind!=='ws_open'&&relay.kind!=='ws_send')return allow;
  if(!nativeChannelBinding){
    const row=await activeGatewaySession(db,relay.sessionId);
    if(!row||row.machineId!==machineId)return denySession;
    // Old native entries lack an immutable enqueue binding: drop only that
    // channel, so a fresh reconnect in the same batch can still open.
    return isWindowsNativeRuntime(row.runtimeBackend)?denyChannel:allow;
  }
  let binding:GatewayChannelBinding;
  try{
    binding=JSON.parse(nativeChannelBinding) as GatewayChannelBinding;
    if(!relay.channelId||binding.sessionId!==relay.sessionId||binding.machineId!==machineId
      ||!isWindowsNativeRuntime(binding.runtimeBackend)||typeof binding.browserSessionKey!=='string')return denyChannel;
  }catch{return denyChannel;}
  // Read the cookie first, then serialize the final exact-cookie/channel check
  // with PostgreSQL STOP/status updates. If the read or SQL started before a
  // revocation, a STOP that commits first still makes this operation deny.
  const browserRaw=await redis.get(binding.browserSessionKey);
  let browser:unknown;
  try{browser=browserRaw?JSON.parse(browserRaw):null;}catch{return denyChannel;}
  if(typeof browser!=='object'||browser===null||!('sessionId' in browser)||browser.sessionId!==relay.sessionId
    ||!('userId' in browser)||typeof browser.userId!=='string'||!browserRaw)return denyChannel;
  // Preserve why the final fence failed. A PostgreSQL/session denial must
  // invalidate earlier positives for the whole session in this batch, while
  // an exact Redis channel/cookie mismatch only invalidates that connection.
  // Treat timeouts and incomplete Redis reads as session-wide unknowns so the
  // delivery path remains fail-closed.
  let databaseAuthorityObserved=false;
  let redisFenceCompleted=false;
  let redisFenceAccepted=false;
  let sessionActiveAtAdmission=false;
  const authorized=await withNativeGatewaySessionFence(
    db,relay.sessionId,machineId,browser.userId,binding.runtimeBackend,
    async isActive=>{
      databaseAuthorityObserved=true;
      redisFenceAccepted=Number(await redis.eval(
        NATIVE_DELIVERY_FENCE_SCRIPT,2,wsChannelKey(relay.channelId!),binding.browserSessionKey,nativeChannelBinding,browserRaw,
      ))===1;
      redisFenceCompleted=true;
      if(!redisFenceAccepted)return false;
      sessionActiveAtAdmission=isActive();
      return sessionActiveAtAdmission;
    },
  );
  if(authorized)return allow;
  if(!databaseAuthorityObserved||!redisFenceCompleted||redisFenceAccepted&&!sessionActiveAtAdmission)return denySession;
  return denyChannel;
}

export async function authorizeQueuedGatewayBatch(db:PrismaClient,redis:Redis,machineId:string,items:RelayRequest[]):Promise<RelayRequest[]>{
  const authorizedItems:RelayRequest[]=[];
  const deniedSessions=new Set<string>();const deniedChannels=new Set<string>();
  const channelScope=(item:RelayRequest)=>JSON.stringify([item.sessionId,item.channelId]);
  for(const item of items){
    const decision=await decideQueuedGatewayRelay(db,redis,machineId,item);
    if(decision.relay)authorizedItems.push(decision.relay);
    else if(decision.scope==='session')deniedSessions.add(item.sessionId);
    else deniedChannels.add(channelScope(item));
  }
  // A later DB denial fences the entire session. A closed/replaced channel
  // fences only that connection, never a fresh reconnect's independent OPEN.
  return authorizedItems.filter(item=>item.kind==='ws_close'||(!deniedSessions.has(item.sessionId)&&!deniedChannels.has(channelScope(item))));
}

// Commercial activation requires a first frame accepted by Redis and a receipt
// committed in the same DB transaction as these writes. This is NOT proof of
// delivery to the browser. Merely opening a URL never activates paid time.
// booking.workspaceActivatedAt (not booking.status alone) is the
// idempotency guard: with the private-beta GPU_DIAGNOSTIC path, a booking can already be
// ACTIVE (proving the GPU works) well before any interactive workspace ever opens - GPU
// Proof and any wait before the renter opens their workspace must never consume purchased
// minutes, so both STARTING and ACTIVE are valid pre-activation states here, and only
// workspaceActivatedAt:null distinguishes "not yet really started" from "already running".
// Exported (kept otherwise unused outside this module) so it can be exercised directly
// against a real database in tests, the same convention gpu-proof-completion.ts's
// completeGpuProofJob already uses - not re-simulated in a test that only reads source.
export async function activateGatewaySession(db:PrismaClient,sessionId:string,machineId:string){
  return db.$transaction(tx=>activateGatewaySessionTx(tx,sessionId,machineId));
}

async function activateGatewaySessionTx(tx:Prisma.TransactionClient,sessionId:string,machineId:string){
    const row=await tx.workspaceSession.findFirst({
      where:{id:sessionId,machineId,runtimeBackend:{in:gatewayRuntimeBackends()},status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},expiresAt:{gt:new Date()},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},
      select:{id:true,bookingId:true,status:true,expiresAt:true,booking:{select:{status:true,expectedSeconds:true,workspaceActivatedAt:true}}},
    });
    if(!row)return null;
    if(row.booking.workspaceActivatedAt!==null)return {activated:false,expiresAt:row.expiresAt};
    if(row.status!==WorkspaceSessionStatus.READY||(row.booking.status!==BookingStatus.STARTING&&row.booking.status!==BookingStatus.ACTIVE))return null;
    const activatedAt=new Date();const expiresAt=new Date(activatedAt.getTime()+row.booking.expectedSeconds*1000);
    const sessionUpdate=await tx.workspaceSession.updateMany({where:{id:row.id,status:WorkspaceSessionStatus.READY},data:{status:WorkspaceSessionStatus.RUNNING,startedAt:activatedAt,expiresAt,preparationStep:'INTERACTIVE_WORKSPACE_CONNECTED'}});
    if(sessionUpdate.count!==1){
      const winner=await tx.workspaceSession.findFirst({where:{id:row.id,machineId,runtimeBackend:{in:gatewayRuntimeBackends()},status:WorkspaceSessionStatus.RUNNING,booking:{workspaceActivatedAt:{not:null}}},select:{expiresAt:true}});
      return winner?{activated:false,expiresAt:winner.expiresAt}:null;
    }
    const bookingUpdate=await tx.booking.updateMany({where:{id:row.bookingId,workspaceActivatedAt:null},data:{status:BookingStatus.ACTIVE,startsAt:activatedAt,endsAt:expiresAt,workspaceActivatedAt:activatedAt}});
    if(bookingUpdate.count!==1)throw new Error('workspace_activation_booking_conflict');
    await tx.machineAllocation.updateMany({where:{bookingId:row.bookingId},data:{startsAt:activatedAt,endsAt:expiresAt}});
    await tx.acceleratorAllocation.updateMany({where:{bookingId:row.bookingId},data:{startsAt:activatedAt,endsAt:expiresAt}});
    await tx.workspaceSessionEvent.create({data:{sessionId:row.id,actorType:'RENTER',action:'INTERACTIVE_WORKSPACE_CONNECTED'}});
    return {activated:true,expiresAt};
}

type AcceptedGatewayFrame={enqueued:number;expiresAt?:Date};

// Redis acceptance is the external decision made inside a locked PostgreSQL
// activation transaction. A rejected/unknown acceptance cannot commit billing.
// The receipt gates first-frame delivery until that DB transaction commits.
export async function acceptGatewayFrame({db,redis,sessionId,machineId,channelId,bindingRaw,frame,markerKey}: {
  db:PrismaClient;redis:Redis;sessionId:string;machineId:string;channelId:string;
  bindingRaw:string;frame:{dataBase64:string;binary:boolean;close:boolean};markerKey?:string;
}):Promise<AcceptedGatewayFrame>{
  const binding=JSON.parse(bindingRaw) as GatewayChannelBinding;
  let receiptId:string|undefined;const markerOwner=crypto.randomUUID();
  let payload=JSON.stringify(frame);
  let accepted=false;
  let abandoned=false;
  const compensate=async()=>{
    await redis.eval(COMPENSATE_GATEWAY_ACCEPTANCE_SCRIPT,3,wsInputKey(channelId),wsInputBytesKey(channelId),markerKey??wsInputKey(channelId),
      payload,String(Buffer.byteLength(payload,'utf8')),markerKey?'1':'0',markerOwner);
  };
  const enqueue=async()=>{
    const bytes=String(Buffer.byteLength(payload,'utf8'));
    const operation=markerKey
      ? redis.eval(ENQUEUE_DEDUPED_WS_FRAME_SCRIPT,5,markerKey,wsInputKey(channelId),wsInputBytesKey(channelId),wsChannelKey(channelId),binding.browserSessionKey,
          String(WS_FRAME_DEDUPE_TTL_SECONDS),String(WS_INPUT_TTL_SECONDS),payload,bytes,String(WS_INPUT_MAX_ITEMS),String(WS_REDIS_INPUT_MAX_BYTES),bindingRaw,isWindowsNativeRuntime(binding.runtimeBackend)?'1':'0',markerOwner)
      : redis.eval(ENQUEUE_BOUND_WS_FRAME_SCRIPT,4,wsInputKey(channelId),wsInputBytesKey(channelId),wsChannelKey(channelId),binding.browserSessionKey,
          payload,String(WS_INPUT_TTL_SECONDS),bytes,String(WS_INPUT_MAX_ITEMS),String(WS_REDIS_INPUT_MAX_BYTES),bindingRaw,isWindowsNativeRuntime(binding.runtimeBackend)?'1':'0');
    let timer:ReturnType<typeof setTimeout>|undefined;
    // A timed-out Redis request may still execute later. Its orphaned first
    // frame has no committed receipt; also compensate when a late reply arrives.
    void operation.then(value=>{if(abandoned&&receiptId&&Number(value)===1)void compensate().catch(()=>undefined);},()=>undefined);
    try{return Number(await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('gateway_acceptance_redis_timeout')),5000);})]));}
    finally{if(timer!==undefined)clearTimeout(timer);}
  };
  if(frame.close)return {enqueued:await enqueue()};
  // Redis activation markers are hints, never authorization. A STOP or expiry
  // in PostgreSQL must also fence frames from an already activated session.
  try{
    return await db.$transaction(async tx=>{
      // Serialize first-frame contenders and STOP/status updates on this row.
      // Redis and PostgreSQL still do NOT constitute a common atomic store.
      await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "id"=${sessionId} FOR UPDATE`;
      const row=await tx.workspaceSession.findFirst({where:{id:sessionId,machineId,
        runtimeBackend:binding.runtimeBackend,status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},expiresAt:{gt:new Date()},
        machine:{connectivity:MachineConnectivity.ONLINE,moderationStatus:ModerationStatus.CLEAR}},
        select:{startedAt:true,expiresAt:true,booking:{select:{workspaceActivatedAt:true,status:true}}}});
      if(!row||(!row.booking.workspaceActivatedAt&&(row.startedAt!==null||row.booking.status!==BookingStatus.STARTING&&row.booking.status!==BookingStatus.ACTIVE)))return {enqueued:-2};
      if(row.booking.workspaceActivatedAt!==null)return {enqueued:await enqueue(),expiresAt:row.expiresAt};
      if(row.booking.workspaceActivatedAt===null){
        receiptId=crypto.randomUUID();
        payload=JSON.stringify({...frame,activationReceiptId:receiptId});
      }
      const enqueued=await enqueue();
      if(enqueued!==1)return {enqueued}; // No activation writes on any refusal or duplicate.
      accepted=true;
      const activation=await activateGatewaySessionTx(tx,sessionId,machineId);
      if(!activation)throw new Error('interactive_workspace_not_activatable');
      if(receiptId)await tx.workspaceGatewayAcceptance.create({data:{id:receiptId,sessionId,channelId,
        bindingSha256:crypto.createHash('sha256').update(bindingRaw).digest('hex'),
        payloadSha256:crypto.createHash('sha256').update(payload).digest('hex'),acceptedAt:new Date(),expiresAt:activation.expiresAt}});
      return {enqueued,expiresAt:activation.expiresAt};
    },{maxWait:5000,timeout:10000});
  }catch(error){
    // A DB commit acknowledgement can be lost. Preserve a committed receipt
    // if it can be recovered; never blindly roll back another activation.
    if(receiptId){
      let committed;
      try{committed=await db.workspaceGatewayAcceptance.findUnique({where:{id:receiptId}});}
      catch{
        // Unknown is not absent: the commit may have succeeded. Removing its
        // accepted frame here would leave billing without the accepted payload.
        // Keep the receipt-gated frame; delivery retries the authoritative read.
        throw error;
      }
      if(committed)return {enqueued:1,expiresAt:committed.expiresAt};
    }
    // Only uncommitted first-frame admissions require compensation. An already
    // activated session has valid queued bytes even when Redis's ACK is late.
    // Mark abandonment after the receipt check: a lost DB commit ACK must not
    // cause the late Redis callback to delete a committed, billable frame.
    abandoned=true;
    if(accepted)await compensate().catch(()=>undefined);
    throw error;
  }
}

export async function committedGatewayFrame(db:PrismaClient,sessionId:string,channelId:string,bindingRaw:string,payload:string):Promise<boolean>{
  const parsed=JSON.parse(payload) as {activationReceiptId?:unknown};
  if(parsed.activationReceiptId===undefined)return true;
  if(typeof parsed.activationReceiptId!=='string')throw new Error('gateway_acceptance_receipt_invalid');
  const receipt=await db.workspaceGatewayAcceptance.findUnique({where:{id:parsed.activationReceiptId}});
  if(!receipt)return false;
  if(receipt.sessionId!==sessionId||receipt.channelId!==channelId||receipt.expiresAt.getTime()<=Date.now()
    ||receipt.bindingSha256!==crypto.createHash('sha256').update(bindingRaw).digest('hex')
    ||receipt.payloadSha256!==crypto.createHash('sha256').update(payload).digest('hex'))throw new Error('gateway_acceptance_receipt_mismatch');
  return true;
}

async function markAcceptedGatewayFrame(redis:Redis,sessionId:string,channelId:string,binding:GatewayChannelBinding,expiresAt?:Date){
  const ttl=expiresAt?Math.max(1,Math.min(SESSION_TTL_SECONDS,Math.ceil((expiresAt.getTime()-Date.now())/1000))):await redis.ttl(wsSessionActivatedKey(sessionId));
  if(ttl<1)return;
  // Activation is an already committed DB fact, never the proof of delivery.
  await redis.set(wsSessionActivatedKey(sessionId),'1','EX',ttl);
  await redis.expire(binding.browserSessionKey,ttl);
  await redis.set(wsUpstreamReadyKey(channelId),'1','EX',ttl);
  await redis.expire(wsChannelKey(channelId),ttl);
}

export function registerWorkspaceGatewayRoutes(app:FastifyInstance,db:PrismaClient,redis:Redis):void{
  app.get('/workspace-gateway/:sessionId',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');const grant=String((request.query as {grant?:string}).grant||'');const consumed=await consumeWorkspaceAccessGrant(redis,grant);
    if(!consumed||consumed.sessionId!==sessionId)return reply.code(401).send({error:'invalid_workspace_grant'});const row=await activeGatewaySession(db,sessionId);if(!row||row.renterId!==consumed.userId)return reply.code(409).send({error:'workspace_not_available'});
    const browserToken=crypto.randomBytes(32).toString('base64url');const ttl=Math.max(30,Math.min(SESSION_TTL_SECONDS,Math.floor((row.expiresAt.getTime()-Date.now())/1000)));await redis.set(gatewaySessionKey(browserToken),JSON.stringify({userId:row.renterId,sessionId,accessRequestId:consumed.requestId}),'EX',ttl);
    // Consuming a grant only authenticates the browser. Billing and the purchased
    // duration start later, after the agent proves that code-server exchanged a
    // real WebSocket frame with this authenticated browser.
    // Entry comes from the Netlify renter portal. Lax is required for the cookie
    // to survive that top-level cross-site navigation and its same-origin redirect;
    // HttpOnly, Secure and the per-session Path keep it scoped to this gateway.
    reply.setCookie(GATEWAY_COOKIE,browserToken,{httpOnly:true,secure:true,sameSite:'lax',path:`/workspace-gateway/${sessionId}`});
    if(isWindowsNativeRuntime(row.runtimeBackend)){
      const host=String(request.headers.host||'').trim();
      if(!host)return reply.code(400).send({error:'workspace_host_required'});
      const target=new URL(
        `/windows-native-desktop.html?session=${encodeURIComponent(sessionId)}`,
        `https://${host}`,
      ).toString();
      return reply.code(302).header('Location',target).send();
    }
    return reply.redirect(`/workspace-gateway/${sessionId}/`);
  });
  app.all('/workspace-gateway/:sessionId/*',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');const token=parseCookie(request.headers.cookie,GATEWAY_COOKIE);if(!token)return reply.code(401).send({error:'workspace_auth_required'});const raw=await redis.get(gatewaySessionKey(token));if(!raw)return reply.code(401).send({error:'workspace_session_expired'});const browser=JSON.parse(raw) as {userId:string;sessionId:string;accessRequestId?:string};if(browser.sessionId!==sessionId)return reply.code(403).send({error:'workspace_session_mismatch'});const row=await activeGatewaySession(db,sessionId);if(!row||row.renterId!==browser.userId)return reply.code(409).send({error:'workspace_not_available'});
    if(isWindowsNativeRuntime(row.runtimeBackend))return reply.code(404).send({error:'windows_native_websocket_only'});
    const suffix='/'+String((request.params as {'*'?:string})['*']||'');const query=request.url.includes('?')?'?'+request.url.split('?').slice(1).join('?'):'';const targetPath=`${suffix}${query}`;if(!safePath(targetPath))return reply.code(400).send({error:'invalid_gateway_path'});const body=request.rawBody??Buffer.alloc(0);if(body.length>10*1024*1024)return reply.code(413).send({error:'gateway_body_too_large'});
    const id=crypto.randomUUID();const relay:RelayRequest={id,sessionId,kind:'http',method:request.method,path:targetPath,headers:relayHeaders(request.headers as Record<string,unknown>),bodyBase64:body.toString('base64')};if(!await enqueueMachineRelay(redis,row.machineId,relay))return reply.code(503).send({error:'workspace_gateway_backpressure'});const result=await waitJson(redis,responseKey(id));if(!result)return reply.code(504).send({error:'workspace_gateway_timeout'});for(const [name,value] of Object.entries(result.headers||{})){if(SAFE_RESPONSE_HEADERS.has(name.toLowerCase()))reply.header(name,value);}if(result.error)return reply.code(502).send({error:'workspace_upstream_error'});return reply.code(Math.max(100,Math.min(599,result.status||502))).send(Buffer.from(result.bodyBase64||'','base64'));
  });
  app.get('/agent/workspace-gateway/:machineId/desired',async(request,reply)=>{
    const machineId=String((request.params as {machineId?:string}).machineId||'');const route=`/agent/workspace-gateway/${machineId}/desired`;if(!await authenticateAgent(db,redis,machineId,request,route))return reply.code(401).send({error:'invalid_agent_request'});
    const rows=await db.workspaceSession.findMany({where:{machineId,runtimeBackend:{in:gatewayRuntimeBackends()},status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING,WorkspaceSessionStatus.STOP_REQUESTED,WorkspaceSessionStatus.STOPPING]},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,status:true,expiresAt:true,runtimeBackend:true,connectionMetadata:true,resourceLimits:true,machineWorkspace:{select:{workspace:{select:{slug:true}}}}}});
    // The agent needs to know which container/image to run per session - a
    // flat workspaceSlug is what workspace_gateway.py's _reconcile_sessions
    // reads (defaulting to 'developer' for any older/unrecognized value).
    const approvedConsoleCommit=privateConsoleAgentCommit();
    const sessions=rows.map(({machineWorkspace,resourceLimits,...row})=>({
      ...row,
      workspaceSlug:machineWorkspace.workspace.slug,
      ...(row.runtimeBackend === WorkspaceRuntimeBackend.WINDOWS_NATIVE
        ? privateConsoleDesiredFields(resourceLimits,approvedConsoleCommit)
        : {}),
    }));
    return {sessions,dataPlane:{hostTunnelEnabled:dataPlaneHostBootstrapEnabled()}};
  });
  app.get('/agent/workspace-gateway/:machineId/sessions/:sessionId/data-plane-host',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(request,reply)=>{
    const params=request.params as {machineId?:string;sessionId?:string};const machineId=String(params.machineId||'');const sessionId=String(params.sessionId||'');const route=`/agent/workspace-gateway/${machineId}/sessions/${sessionId}/data-plane-host`;if(!await authenticateAgent(db,redis,machineId,request,route))return reply.code(401).send({error:'invalid_agent_request'});
    const runtime=loadDataPlaneHostRuntimeConfig();if(!runtime)return reply.code(404).send({error:'data_plane_disabled'});
    const row=await db.workspaceSession.findFirst({where:{id:sessionId,machineId,runtimeBackend:{in:gatewayRuntimeBackends()},status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},expiresAt:{gt:new Date()},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,machineId:true,bookingId:true,renterId:true}});if(!row)return reply.code(404).send({error:'workspace_session_not_available'});
    return issueHostTunnelBootstrap(runtime,{sessionId:row.id,machineId:row.machineId,bookingId:row.bookingId,renterUserId:row.renterId});
  });
  app.get('/agent/workspace-gateway/:machineId/next',{config:{rateLimit:{max:AGENT_TUNNEL_RATE_LIMIT_PER_MINUTE,timeWindow:'1 minute'}}},async(request,reply)=>{const machineId=String((request.params as {machineId?:string}).machineId||'');const route=`/agent/workspace-gateway/${machineId}/next`;if(!await authenticateAgent(db,redis,machineId,request,route))return reply.code(401).send({error:'invalid_agent_request'});const raw=await waitForGatewayQueueItem(redis,machineQueue(machineId));if(!raw)return reply.code(204).send();await accountDequeuedBytes(redis,machineQueueBytesKey(machineId),raw,MACHINE_QUEUE_TTL_SECONDS);const relay=await authorizeQueuedGatewayRelay(db,redis,machineId,JSON.parse(raw) as RelayRequest);return relay??reply.code(204).send();});
  app.get('/agent/workspace-gateway/:machineId/next-batch',{config:{rateLimit:{max:AGENT_TUNNEL_RATE_LIMIT_PER_MINUTE,timeWindow:'1 minute'}}},async(request,reply)=>{
    const machineId=String((request.params as {machineId?:string}).machineId||'');const route=`/agent/workspace-gateway/${machineId}/next-batch`;if(!await authenticateAgent(db,redis,machineId,request,route))return reply.code(401).send({error:'invalid_agent_request'});
    const queueKey=machineQueue(machineId);const bytesKey=machineQueueBytesKey(machineId);const first=await waitForGatewayQueueItem(redis,queueKey);if(!first)return reply.code(204).send();
    await accountDequeuedBytes(redis,bytesKey,first,MACHINE_QUEUE_TTL_SECONDS);
    const items:RelayRequest[]=[JSON.parse(first) as RelayRequest];let batchBytes=Buffer.byteLength(first,'utf8');
    while(items.length<AGENT_NEXT_BATCH_MAX_ITEMS){
      const raw=await redis.rpop(queueKey);if(!raw)break;const candidateBytes=Buffer.byteLength(raw,'utf8')+1;
      if(batchBytes+candidateBytes>AGENT_NEXT_BATCH_MAX_JSON_BYTES){await redis.rpush(queueKey,raw);break;}
      await accountDequeuedBytes(redis,bytesKey,raw,MACHINE_QUEUE_TTL_SECONDS);
      items.push(JSON.parse(raw) as RelayRequest);batchBytes+=candidateBytes;
    }
    return {items:await authorizeQueuedGatewayBatch(db,redis,machineId,items)};
  });
  app.post('/agent/workspace-gateway/:sessionId/register',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');const body=request.body as {machineId?:string;runtimeId?:string;localPort?:number};const machineId=String(body.machineId||'');const route=`/agent/workspace-gateway/${sessionId}/register`;if(!await authenticateAgent(db,redis,machineId,request,route,true))return reply.code(401).send({error:'invalid_agent_request'});if(!/^[a-zA-Z0-9_.-]{6,100}$/.test(String(body.runtimeId||''))||!Number.isInteger(body.localPort)||Number(body.localPort)<1024||Number(body.localPort)>65535)return reply.code(400).send({error:'invalid_runtime_registration'});
    const row=await db.workspaceSession.findFirst({where:{id:sessionId,machineId,runtimeBackend:{in:gatewayRuntimeBackends()},status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,renterId:true,runtimeBackend:true,status:true,bookingId:true,connectionMetadata:true,booking:{select:{expectedSeconds:true}}}});if(!row)return reply.code(409).send({error:'workspace_not_registerable'});
    const register=async(tx:Prisma.TransactionClient,current:{id:string;status:WorkspaceSessionStatus;bookingId:string;connectionMetadata:Prisma.JsonValue|null},requireFundedBooking:boolean):Promise<boolean>=>{
      const metadata=current.connectionMetadata&&typeof current.connectionMetadata==='object'?current.connectionMetadata as Record<string,unknown>:null;
      const firstRegistration=current.status===WorkspaceSessionStatus.READY&&typeof metadata?.gatewayPath!=='string';
      const readyAt=new Date();const activationDeadline=new Date(readyAt.getTime()+INTERACTIVE_CONNECT_TIMEOUT_SECONDS*1000);
      if(firstRegistration){
        const booking=await tx.booking.updateMany({where:{id:current.bookingId,status:BookingStatus.FUNDED},data:{status:BookingStatus.STARTING,startsAt:readyAt,endsAt:activationDeadline}});
        if(requireFundedBooking&&booking.count!==1)return false;
        await tx.machineAllocation.updateMany({where:{bookingId:current.bookingId},data:{startsAt:readyAt,endsAt:activationDeadline}});
        await tx.acceleratorAllocation.updateMany({where:{bookingId:current.bookingId},data:{startsAt:readyAt,endsAt:activationDeadline}});
      }
      await tx.workspaceSession.update({where:{id:current.id},data:{connectionType:'GPUbnbGateway',connectionMetadata:{gatewayPath:`/workspace-gateway/${sessionId}`,runtimeId:String(body.runtimeId),localPort:Number(body.localPort)},gatewayLastSeenAt:readyAt,...(firstRegistration?{readyAt,startedAt:null,expiresAt:activationDeadline,preparationProgress:100,preparationStep:'WAITING_FOR_INTERACTIVE_CONNECTION'}:{}),events:{create:{actorType:'AGENT',actorId:machineId,action:'GATEWAY_READY'}}}});
      return true;
    };
    if(isWindowsNativeRuntime(row.runtimeBackend)){
      const accepted=await withNativeGatewaySessionFence(db,sessionId,machineId,row.renterId,row.runtimeBackend,async(isActive,tx)=>{
        const current=await tx.workspaceSession.findFirst({where:{id:sessionId,machineId,runtimeBackend:row.runtimeBackend,status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,status:true,bookingId:true,connectionMetadata:true}});
        if(!current||!isActive())return false;
        return await register(tx,current,true)&&isActive();
      },{lockSessionForMutation:true});
      if(!accepted)return reply.code(409).send({error:'workspace_not_registerable'});
    }else{
      const current=await db.workspaceSession.findFirst({where:{id:sessionId,machineId,runtimeBackend:{in:gatewayRuntimeBackends()},status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,status:true,bookingId:true,connectionMetadata:true}});
      if(!current)return reply.code(409).send({error:'workspace_not_registerable'});
      await db.$transaction(async tx=>register(tx,current,false));
    }
    return {ok:true,gatewayPath:`/workspace-gateway/${sessionId}`};
  });
  app.post('/agent/workspace-gateway/:sessionId/usage',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');
    const body=request.body as {machineId?:string;counter?:string;intervalSeconds?:number;available?:boolean};
    const machineId=String(body.machineId||'');const route=`/agent/workspace-gateway/${sessionId}/usage`;
    if(!await authenticateAgent(db,redis,machineId,request,route,true))return reply.code(401).send({error:'invalid_agent_request'});
    if(!/^\d{1,20}$/.test(String(body.counter||''))||!Number.isInteger(body.intervalSeconds)||Number(body.intervalSeconds)<1||Number(body.intervalSeconds)>30||body.available!==true)return reply.code(400).send({error:'invalid_usage_sample'});
    const counter=BigInt(String(body.counter));
    const row=await db.workspaceSession.findFirst({where:{id:sessionId,machineId,runtimeBackend:{in:gatewayRuntimeBackends()},status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},readyAt:{not:null},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,renterId:true,runtimeBackend:true,status:true,bookingId:true,lastMetricCounter:true,booking:{select:{status:true,validSeconds:true,expectedSeconds:true}}}});
    if(!row)return reply.code(409).send({error:'workspace_not_billable'});
    if(isWindowsNativeRuntime(row.runtimeBackend)){
      let conflict='workspace_not_billable';
      let acceptedUsage:{validIncrement:number;pendingActivation:boolean}|null=null;
      const accepted=await withNativeGatewaySessionFence(db,sessionId,machineId,row.renterId,row.runtimeBackend,async(isActive,tx)=>{
        const current=await tx.workspaceSession.findFirst({where:{id:sessionId,machineId,runtimeBackend:row.runtimeBackend,status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},readyAt:{not:null},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,status:true,bookingId:true,lastMetricCounter:true,booking:{select:{status:true,validSeconds:true,expectedSeconds:true}}}});
        if(!current||!isActive())return false;
        const pendingActivation=current.status===WorkspaceSessionStatus.READY&&current.booking.status===BookingStatus.STARTING;
        const billable=current.status===WorkspaceSessionStatus.RUNNING&&current.booking.status===BookingStatus.ACTIVE;
        if(!pendingActivation&&!billable)return false;
        if(counter<=current.lastMetricCounter){conflict='usage_counter_replay';return false;}
        const sessionUpdate=await tx.workspaceSession.updateMany({where:{id:current.id,status:current.status,lastMetricCounter:{lt:counter}},data:{lastMetricCounter:counter,gatewayLastSeenAt:new Date()}});
        if(sessionUpdate.count!==1){conflict='usage_counter_replay';return false;}
        if(pendingActivation){acceptedUsage={validIncrement:0,pendingActivation:true};return isActive();}
        const increment=Math.min(Number(body.intervalSeconds),Math.max(0,current.booking.expectedSeconds-current.booking.validSeconds));
        const bookingUpdate=await tx.booking.updateMany({where:{id:current.bookingId,status:BookingStatus.ACTIVE,validSeconds:current.booking.validSeconds},data:{validSeconds:{increment}}});
        if(bookingUpdate.count!==1)throw new Error('native_gateway_usage_booking_changed');
        acceptedUsage={validIncrement:increment,pendingActivation:false};
        return isActive();
      },{lockSessionForMutation:true});
      if(!accepted)return reply.code(409).send({error:conflict});
      return {ok:true,...acceptedUsage!};
    }
    const pendingActivation=row.status===WorkspaceSessionStatus.READY&&row.booking.status===BookingStatus.STARTING;
    const billable=row.status===WorkspaceSessionStatus.RUNNING&&row.booking.status===BookingStatus.ACTIVE;
    if(!pendingActivation&&!billable)return reply.code(409).send({error:'workspace_not_billable'});
    if(counter<=row.lastMetricCounter)return reply.code(409).send({error:'usage_counter_replay'});
    if(pendingActivation){
      await db.workspaceSession.update({where:{id:row.id},data:{lastMetricCounter:counter,gatewayLastSeenAt:new Date()}});
      return {ok:true,validIncrement:0,pendingActivation:true};
    }
    const increment=Math.min(Number(body.intervalSeconds),Math.max(0,row.booking.expectedSeconds-row.booking.validSeconds));
    await db.$transaction([
      db.workspaceSession.update({where:{id:row.id},data:{lastMetricCounter:counter,gatewayLastSeenAt:new Date()}}),
      db.booking.update({where:{id:row.bookingId},data:{validSeconds:{increment}}}),
    ]);
    return {ok:true,validIncrement:increment,pendingActivation:false};
  });
  app.post('/agent/workspace-gateway/respond',{bodyLimit:MAX_AGENT_RELAY_BODY_BYTES,config:{rateLimit:{max:AGENT_RESPONSE_RATE_LIMIT_PER_MINUTE,timeWindow:'1 minute'}}},async(request,reply)=>{const body=request.body as {machineId?:string;id?:string;status?:number;headers?:Record<string,string>;bodyBase64?:string;error?:string};const machineId=String(body.machineId||'');const route='/agent/workspace-gateway/respond';if(!await authenticateAgent(db,redis,machineId,request,route,true))return reply.code(401).send({error:'invalid_agent_request'});if(!body.id)return reply.code(400).send({error:'response_id_required'});await redis.set(responseKey(body.id),JSON.stringify({status:body.status||502,headers:body.headers||{},bodyBase64:body.bodyBase64||'',error:body.error}),'EX',60);return {ok:true};});
  app.post('/agent/workspace-gateway/ws-frames',{bodyLimit:MAX_AGENT_RELAY_BODY_BYTES,config:{rateLimit:{max:AGENT_RESPONSE_RATE_LIMIT_PER_MINUTE,timeWindow:'1 minute'}}},async(request,reply)=>{
    const body=request.body as {machineId?:string;frames?:AgentWsFrame[]};const machineId=String(body.machineId||'');const route='/agent/workspace-gateway/ws-frames';
    if(!await authenticateAgent(db,redis,machineId,request,route,true))return reply.code(401).send({error:'invalid_agent_request'});
    if(!Array.isArray(body.frames)||body.frames.length<1||body.frames.length>AGENT_WS_FRAME_BATCH_MAX_ITEMS)return reply.code(400).send({error:'invalid_workspace_ws_frame_batch'});
    let aggregateBase64Bytes=0;
    for(const frame of body.frames){
      const frameId=String(frame.frameId||'');const channelId=String(frame.channelId||'');const close=frame.close===true;const dataBase64=typeof frame.dataBase64==='string'?frame.dataBase64:'';
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(frameId))return reply.code(400).send({error:'frame_id_required'});
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelId))return reply.code(400).send({error:'channel_required'});
      if(!close&&typeof frame.binary!=='boolean')return reply.code(400).send({error:'workspace_ws_binary_metadata_required'});
      if(!close&&!isStrictBase64Payload(dataBase64,WS_MAX_BASE64_BYTES,WS_MAX_FRAME_BYTES))return reply.code(400).send({error:'workspace_ws_frame_invalid_base64'});
      if(close&&dataBase64.length>0)return reply.code(400).send({error:'workspace_ws_close_payload_invalid'});
      aggregateBase64Bytes+=dataBase64.length;if(aggregateBase64Bytes>AGENT_WS_FRAME_BATCH_MAX_BASE64_BYTES)return reply.code(413).send({error:'workspace_ws_frame_batch_too_large'});
    }
    let accepted=0;let duplicates=0;let stale=0;
    for(const frame of body.frames){
      const frameId=String(frame.frameId);const channelId=String(frame.channelId);const markerKey=wsFrameSeenKey(machineId,frameId);
      if(await redis.exists(markerKey)){duplicates++;continue;}
      const close=frame.close===true;const dataBase64=typeof frame.dataBase64==='string'?frame.dataBase64:'';
      const bindingRaw=await redis.get(wsChannelKey(channelId));
      if(!bindingRaw){
        if(close){await redis.set(markerKey,'1','EX',WS_FRAME_DEDUPE_TTL_SECONDS,'NX');stale++;continue;}
        return reply.code(409).send({error:'unknown_gateway_channel'});
      }
      const binding=JSON.parse(bindingRaw) as GatewayChannelBinding;if(binding.machineId!==machineId)return reply.code(403).send({error:'gateway_channel_machine_mismatch'});
      if(!upstreamGatewayFrameAllowed(binding.runtimeBackend,frame.binary===true,close))return reply.code(400).send({error:'windows_native_media_binary_required'});
      const acceptedFrame=await acceptGatewayFrame({db,redis,sessionId:binding.sessionId,machineId,channelId,bindingRaw,frame:{dataBase64,binary:frame.binary===true,close},markerKey});
      const enqueued=acceptedFrame.enqueued;
      if(enqueued===-2){stale++;continue;}
      if(enqueued===-1)return reply.code(429).send({error:'workspace_ws_browser_backpressure'});
      if(enqueued===1){accepted++;if(close)await redis.del(wsChannelKey(channelId),wsUpstreamReadyKey(channelId));else await markAcceptedGatewayFrame(redis,binding.sessionId,channelId,binding,acceptedFrame.expiresAt);}else{duplicates++;}
    }
    return {ok:true,accepted,duplicates,stale};
  });
  app.post('/agent/workspace-gateway/ws-frame',{bodyLimit:MAX_AGENT_RELAY_BODY_BYTES,config:{rateLimit:{max:AGENT_TUNNEL_RATE_LIMIT_PER_MINUTE,timeWindow:'1 minute'}}},async(request,reply)=>{
    const body=request.body as {machineId?:string;channelId?:string;dataBase64?:string;binary?:boolean;close?:boolean};const machineId=String(body.machineId||'');const route='/agent/workspace-gateway/ws-frame';
    if(!await authenticateAgent(db,redis,machineId,request,route,true))return reply.code(401).send({error:'invalid_agent_request'});
    const channelId=String(body.channelId||'');if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelId))return reply.code(400).send({error:'channel_required'});
    const close=body.close===true;const dataBase64=typeof body.dataBase64==='string'?body.dataBase64:'';
    if(!close&&typeof body.binary!=='boolean')return reply.code(400).send({error:'workspace_ws_binary_metadata_required'});
    if(!close&&!isStrictBase64Payload(dataBase64,WS_MAX_BASE64_BYTES,WS_MAX_FRAME_BYTES))return reply.code(400).send({error:'workspace_ws_frame_invalid_base64'});
    if(close&&dataBase64.length>0)return reply.code(400).send({error:'workspace_ws_close_payload_invalid'});
    const bindingRaw=await redis.get(wsChannelKey(channelId));if(!bindingRaw)return close?{ok:true,stale:true}:reply.code(409).send({error:'unknown_gateway_channel'});
    const binding=JSON.parse(bindingRaw) as GatewayChannelBinding;if(binding.machineId!==machineId)return reply.code(403).send({error:'gateway_channel_machine_mismatch'});
    if(!upstreamGatewayFrameAllowed(binding.runtimeBackend,body.binary===true,close))return reply.code(400).send({error:'windows_native_media_binary_required'});
    // A real upstream frame remains the billing activation signal, but only
    // after Redis accepts it and the matching DB receipt commits.
    const acceptedFrame=await acceptGatewayFrame({db,redis,sessionId:binding.sessionId,machineId,channelId,bindingRaw,frame:{dataBase64,binary:body.binary===true,close}});
    const enqueued=acceptedFrame.enqueued;
    if(enqueued===-2)return close?{ok:true,stale:true}:reply.code(409).send({error:'unknown_gateway_channel'});
    if(enqueued===-1)return reply.code(429).send({error:'workspace_ws_browser_backpressure'});
    if(close)await redis.del(wsChannelKey(channelId),wsUpstreamReadyKey(channelId));
    else if(enqueued===1)await markAcceptedGatewayFrame(redis,binding.sessionId,channelId,binding,acceptedFrame.expiresAt);
    return {ok:true};
  });
  app.post('/agent/workspace-gateway/:sessionId/revocation-started',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');
    const body=request.body as {machineId?:string};const machineId=String(body.machineId||'');
    const route=`/agent/workspace-gateway/${sessionId}/revocation-started`;
    if(!await authenticateAgent(db,redis,machineId,request,route,true))return reply.code(401).send({error:'invalid_agent_request'});
    if(!await markNativeGatewayRevocationStarted(db,redis,sessionId,machineId))return reply.code(409).send({error:'workspace_revocation_not_applicable'});
    return {ok:true,revoked:true};
  });
  app.post('/agent/workspace-gateway/:sessionId/stopped',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');const body=request.body as {machineId?:string;cleaned?:boolean};const machineId=String(body.machineId||'');const route=`/agent/workspace-gateway/${sessionId}/stopped`;if(!await authenticateAgent(db,redis,machineId,request,route,true))return reply.code(401).send({error:'invalid_agent_request'});
    const acknowledgeable:WorkspaceSessionStatus[]=[WorkspaceSessionStatus.STOP_REQUESTED,WorkspaceSessionStatus.STOPPING,WorkspaceSessionStatus.RUNNING,WorkspaceSessionStatus.READY];
    const result=await runBookingTransaction(db,async tx=>{
      // Read again on EVERY Serializable retry. A snapshot captured before the
      // transaction would let late ACKs overwrite its winner's terminal state.
      const row=await tx.workspaceSession.findFirst({where:{id:sessionId,machineId,runtimeBackend:{in:gatewayRuntimeBackends()}},select:{id:true,bookingId:true,status:true,startedAt:true}});
      if(!row)return {error:'workspace_not_stoppable'} as const;
      if(!acknowledgeable.includes(row.status)){
        if(body.cleaned===true&&(row.status===WorkspaceSessionStatus.COMPLETED||row.status===WorkspaceSessionStatus.TIMED_OUT)){
          return {ok:true,activated:row.startedAt!==null,machineReleased:false,alreadyApplied:true} as const;
        }
        return {error:row.status===WorkspaceSessionStatus.QUARANTINED?'workspace_cleanup_unverified':'workspace_not_stoppable'} as const;
      }
      const neverActivated=row.startedAt===null;const endedAt=new Date();
      const changed=await tx.workspaceSession.updateMany({
        where:{id:row.id,machineId,runtimeBackend:{in:gatewayRuntimeBackends()},status:{in:acknowledgeable}},
        data:body.cleaned!==true?{status:WorkspaceSessionStatus.QUARANTINED,endedAt}:{
          status:neverActivated?WorkspaceSessionStatus.TIMED_OUT:WorkspaceSessionStatus.COMPLETED,endedAt,connectionMetadata:{},
          ...(neverActivated?{terminationReason:SessionTerminationReason.TIMEOUT,preparationStep:'INTERACTIVE_CONNECTION_TIMEOUT'}:{}),
        },
      });
      if(changed.count!==1)return {error:'workspace_not_stoppable'} as const;
      // Only the CAS winner can emit events, quarantine, settle or release.
      if(body.cleaned!==true){
        await tx.machine.update({where:{id:machineId},data:{operational:MachineOperational.UNAVAILABLE}});
        await enterQuarantine(tx,{machineId,reasonCode:'WORKSPACE_CLEANUP_FAILED',reason:"L'agent a signalé la fin de la session Workspace sans confirmer le nettoyage de l'environnement isolé.",details:{sessionId},source:'workspace-gateway.stopped'});
        return {error:'workspace_cleanup_unverified'} as const;
      }
      await tx.workspaceSessionEvent.create({data:{sessionId:row.id,actorType:'AGENT',actorId:machineId,action:neverActivated?'INTERACTIVE_CONNECTION_NEVER_ESTABLISHED':'GATEWAY_CLEANUP_VERIFIED'}});
      if(neverActivated){
        await tx.booking.updateMany({where:{id:row.bookingId,status:{in:[BookingStatus.FUNDED,BookingStatus.STARTING]}},data:{status:BookingStatus.DEGRADED}});
        await tx.payment.updateMany({where:{bookingId:row.bookingId,status:PaymentStatus.ESCROW_FUNDED},data:{status:PaymentStatus.SETTLEMENT_PENDING}});
      }
      const machineUpdate=await tx.machine.updateMany({
        where:{
          id:machineId,
          moderationStatus:ModerationStatus.CLEAR,
          workspaceSessions:{none:{id:{not:row.id},status:{in:[WorkspaceSessionStatus.RESERVED,WorkspaceSessionStatus.PREPARING,WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING,WorkspaceSessionStatus.STOP_REQUESTED,WorkspaceSessionStatus.STOPPING]}}},
          jobs:{none:{status:{in:[JobStatus.ASSIGNED,JobStatus.DOWNLOADING,JobStatus.PREPARING,JobStatus.RUNNING,JobStatus.UPLOADING_RESULTS,JobStatus.CANCEL_REQUESTED]}}},
          listings:{none:{bookings:{some:{id:{not:row.bookingId},status:{in:[BookingStatus.FUNDED,BookingStatus.STARTING,BookingStatus.ACTIVE,BookingStatus.DEGRADED]}}}}},
        },
        data:{operational:neverActivated?MachineOperational.DEGRADED:MachineOperational.AVAILABLE},
      });
      const release=machineUpdate.count===1;
      return {ok:true,activated:!neverActivated,machineReleased:release,alreadyApplied:false} as const;
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:10_000});
    if('error' in result)return reply.code(409).send({error:result.error});
    await redis.del(wsSessionActivatedKey(sessionId));
    return result;
  });

  const wss=new WebSocketServer({noServer:true,maxPayload:WS_MAX_FRAME_BYTES});
  const healthWss=new WebSocketServer({noServer:true,maxPayload:1024});
  app.server.on('upgrade',async(request,socket,head)=>{
    let url:URL;
    try{url=new URL(request.url||'/',`https://${request.headers.host||'localhost'}`);}catch{
      app.log.warn({event:'workspace_gateway_upgrade_rejected',reason:'invalid_url'},'workspace gateway upgrade rejected');
      rejectWebSocketUpgrade(socket as Socket,404,'websocket_route_not_found');return;
    }

    if(url.pathname===WS_HEALTH_PATH){
      app.log.info({event:'workspace_gateway_health_upgrade'},'workspace gateway websocket health upgrade');
      healthWss.handleUpgrade(request,socket as Socket,head,(ws:WebSocket)=>{ws.send('gpubnb-ws-ok',()=>ws.close(1000,'ok'));});
      return;
    }

    const match=url.pathname.match(/^\/workspace-gateway\/([^/]+)\/(.*)$/);
    if(!match){rejectWebSocketUpgrade(socket as Socket,404,'websocket_route_not_found');return;}
    const sessionId=match[1];const targetSuffix=match[2]??'';const token=parseCookie(request.headers.cookie,GATEWAY_COOKIE);
    app.log.info({event:'workspace_gateway_upgrade_received',sessionId,hasWorkspaceCookie:!!token},'workspace gateway upgrade received');
    if(!token){app.log.warn({event:'workspace_gateway_upgrade_rejected',sessionId,reason:'cookie_missing'},'workspace gateway upgrade rejected');rejectWebSocketUpgrade(socket as Socket,401,'workspace_auth_required');return;}

    try{
      const raw=await redis.get(gatewaySessionKey(token));
      if(!raw){app.log.warn({event:'workspace_gateway_upgrade_rejected',sessionId,reason:'cookie_expired'},'workspace gateway upgrade rejected');rejectWebSocketUpgrade(socket as Socket,401,'workspace_session_expired');return;}
      const browser=JSON.parse(raw) as {userId:string;sessionId:string;accessRequestId?:string};
      if(browser.sessionId!==sessionId){app.log.warn({event:'workspace_gateway_upgrade_rejected',sessionId,reason:'session_mismatch'},'workspace gateway upgrade rejected');rejectWebSocketUpgrade(socket as Socket,403,'workspace_session_mismatch');return;}
      const row=await activeGatewaySession(db,sessionId);
      if(!row||row.renterId!==browser.userId){app.log.warn({event:'workspace_gateway_upgrade_rejected',sessionId,reason:'workspace_unavailable'},'workspace gateway upgrade rejected');rejectWebSocketUpgrade(socket as Socket,409,'workspace_not_available');return;}
      if(!windowsNativeUpgradeAllowed(row.runtimeBackend,targetSuffix,url.search)){
        app.log.warn({event:'workspace_gateway_upgrade_rejected',sessionId,reason:'native_stream_path_invalid'},'workspace gateway upgrade rejected');
        rejectWebSocketUpgrade(socket as Socket,404,'websocket_route_not_found');return;
      }

      wss.handleUpgrade(request,socket as Socket,head,(ws:WebSocket)=>{
        const channelId=crypto.randomUUID();const channelLogId=channelId.slice(0,8);const targetPath='/'+targetSuffix+url.search;const browserSessionKey=gatewaySessionKey(token);
        const channelTtl=Math.max(30,Math.min(SESSION_TTL_SECONDS,Math.ceil((row.expiresAt.getTime()-Date.now())/1000)));
        const openRequestId=crypto.randomUUID();let browserClosed=false;let browserBackpressureSince=0;
        const nativeChannel = isWindowsNativeRuntime(row.runtimeBackend);
        const nativeLease = nativeChannel
          ? createGatewayChannelLeaseGuard({
              sessionId, userId: browser.userId,
              expectedMachineId: row.machineId,
              expectedRuntimeBackend: row.runtimeBackend,
              readBrowser: () => redis.get(browserSessionKey),
              readWorkspace: () => activeGatewaySession(db,sessionId),
              // Native frame/input authorization must not reuse a previously
              // positive result after a server-side revocation. This does not
              // eliminate already-in-flight socket bytes; WTS/worker fencing
              // and physical isolation qualification remain mandatory.
              cacheMs: 0,
            })
          : null;
        const channelAuthorized = async () => {
          if (!nativeLease) return true;
          const allowed = await nativeLease();
          if (!allowed) nativeLease.invalidate();
          return allowed;
        };
        const browserPending=new BrowserPendingBudget();
        const gatewayLog=app.log.child({accessRequestId:browser.accessRequestId,bookingId:row.bookingId,jobId:row.jobId,workspaceSessionId:sessionId,machineId:row.machineId,channelId,channel:channelLogId,openRequestId});
        gatewayLog.info({event:'workspace_gateway_browser_connected'},'workspace gateway browser websocket connected');
        ws.on('error',error=>gatewayLog.warn({err:error,event:'workspace_gateway_browser_socket_error',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway browser websocket error'));
        // Keep queue ordering backward-compatible: browser frames may be queued as
        // soon as ws_open itself is enqueued. LPUSH/RPOP preserves ws_open before
        // ws_send, so legacy agents can still establish code-server and exchange
        // their first frame while newer agents additionally return an explicit ACK.
        const channelBinding=JSON.stringify({sessionId,machineId:row.machineId,browserSessionKey,runtimeBackend:row.runtimeBackend} satisfies GatewayChannelBinding);
        const setup=(async()=>{
          await redis.set(wsChannelKey(channelId),channelBinding,'EX',channelTtl);
          if(browserClosed){
            await redis.del(wsChannelKey(channelId));
            throw new Error('workspace_channel_closed_during_setup');
          }
          const openRelay={id:openRequestId,sessionId,kind:'ws_open',channelId,path:targetPath,headers:relayHeaders(request.headers as Record<string,unknown>)} satisfies RelayRequest;
          const accepted=nativeChannel
            ? await enqueueAuthorizedNativeMachineRelay(db,redis,sessionId,browser.userId,row.machineId,row.runtimeBackend,channelId,channelBinding,browserSessionKey,openRelay)
            : await enqueueMachineRelay(redis,row.machineId,openRelay);
          if(!accepted)throw new Error('workspace_machine_queue_backpressure');
        })();
        const upstreamProbe=setup.then(async()=>{
          const opened=await waitJson(redis,responseKey(openRequestId),WS_UPSTREAM_OPEN_TIMEOUT_MS);
          if(browserClosed)return;
          if(opened){
            if(opened.error||opened.status!==101)throw new Error(`workspace_upstream_open_failed:${opened.error||opened.status}`);
            await redis.set(wsUpstreamReadyKey(channelId),'1','EX',channelTtl);
            gatewayLog.info({event:'workspace_gateway_upstream_opened',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway upstream websocket opened');
            return;
          }
          // Old agents do not answer ws_open. Preserve their previous behavior:
          // a signed first upstream frame proves the local WebSocket is alive.
          const legacyReady=await redis.get(wsUpstreamReadyKey(channelId));
          if(browserClosed)return;
          if(legacyReady){gatewayLog.info({event:'workspace_gateway_legacy_upstream_ready',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway legacy agent produced an upstream frame');return;}
          throw new Error('workspace_upstream_open_timeout');
        });
        void upstreamProbe.catch(error=>{if(browserClosed)return;gatewayLog.error({err:error,event:'workspace_gateway_upstream_open_failed',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway upstream websocket failed to open');if(ws.readyState===WebSocket.OPEN)ws.close(1011,'workspace upstream unavailable');});

        let pumpBusy=false;let pendingAcceptanceFrame:string|null=null;let pendingAcceptanceSince=0;
        const pump=setInterval(()=>{
          if(pumpBusy||browserClosed)return;
          if(ws.bufferedAmount>WS_BROWSER_BUFFERED_HIGH_WATER_BYTES){
            if(browserBackpressureSince===0)browserBackpressureSince=Date.now();
            if(Date.now()-browserBackpressureSince>WS_BROWSER_BACKPRESSURE_TIMEOUT_MS){
              gatewayLog.error({event:'workspace_gateway_browser_backpressure_timeout',sessionId,machineId:row.machineId,channel:channelLogId,bufferedAmount:ws.bufferedAmount},'workspace gateway browser backpressure timed out');
              browserClosed=true;clearInterval(pump);if(ws.readyState===WebSocket.OPEN)ws.close(1013,'browser backpressure');
            }
            return;
          }
          browserBackpressureSince=0;
          pumpBusy=true;
          void (async()=>{
            if(!await channelAuthorized() || browserClosed || ws.readyState!==WebSocket.OPEN){
              browserClosed=true;clearInterval(pump);
              if(ws.readyState===WebSocket.OPEN)ws.close(1008,'workspace session expired');
              return;
            }
            for(let i=0;i<50;i++){
              if(browserClosed || ws.readyState!==WebSocket.OPEN)break;
              if(ws.bufferedAmount>WS_BROWSER_BUFFERED_HIGH_WATER_BYTES)break;
              const frame=pendingAcceptanceFrame??await redis.rpop(wsInputKey(channelId));if(!frame)break;
              if(!await committedGatewayFrame(db,sessionId,channelId,channelBinding,frame)){
                pendingAcceptanceFrame=frame;
                if(pendingAcceptanceSince===0)pendingAcceptanceSince=performance.now();
                if(performance.now()-pendingAcceptanceSince>15000){
                  // An aborted first-frame transaction may leave a receipt-tagged
                  // item already popped from Redis. Never deliver an uncommitted
                  // frame, but do not permanently poison a healthy channel or
                  // block a later, independently committed retry behind it.
                  gatewayLog.warn({event:'gateway_acceptance_uncommitted_discarded',sessionId,channel:channelLogId},'uncommitted first frame expired');
                  pendingAcceptanceFrame=null;pendingAcceptanceSince=0;
                  await accountDequeuedBytes(redis,wsInputBytesKey(channelId),frame,WS_INPUT_TTL_SECONDS);
                  continue;
                }
                break;
              }
              pendingAcceptanceFrame=null;pendingAcceptanceSince=0;
              await accountDequeuedBytes(redis,wsInputBytesKey(channelId),frame,WS_INPUT_TTL_SECONDS);
              const parsed=JSON.parse(frame) as {dataBase64?:unknown;binary?:unknown;close?:unknown};
              if(parsed.close===true){if(ws.readyState===WebSocket.OPEN)ws.close(1000,'upstream closed');break;}
              if(typeof parsed.binary!=='boolean'||typeof parsed.dataBase64!=='string'||
                !isStrictBase64Payload(parsed.dataBase64,WS_MAX_BASE64_BYTES,WS_MAX_FRAME_BYTES))throw new Error('workspace_ws_redis_frame_invalid');
              const dataBase64:string=parsed.dataBase64;
              const binary:boolean=parsed.binary;
              if(nativeChannel){
                // Hold the PostgreSQL session row lock through the final Redis
                // fence and synchronous ws.send. STOP/status updates therefore
                // serialize with this commit point; a pre-STOP DB read cannot
                // authorize a buffered frame after STOP has committed. Bytes
                // already accepted by ws.send/TCP remain non-recallable.
                const delivered=await withNativeGatewaySessionFence(db,sessionId,row.machineId,browser.userId,row.runtimeBackend,async isActive=>{
                  // `raw` was identity-checked at upgrade. Requiring Redis to
                  // still contain those exact bytes detects deletion or
                  // rotation in one atomic final check without another GET.
                  if(Number(await redis.eval(NATIVE_DELIVERY_FENCE_SCRIPT,2,wsChannelKey(channelId),browserSessionKey,channelBinding,raw))!==1||!isActive())return false;
                  if(browserClosed||ws.readyState!==WebSocket.OPEN)return false;
                  ws.send(Buffer.from(dataBase64,'base64'),{binary});
                  return true;
                });
                if(!delivered){
                  browserClosed=true;clearInterval(pump);nativeLease?.invalidate();
                  if(ws.readyState===WebSocket.OPEN)ws.close(1008,'native workspace revoked');
                  return;
                }
              }else if(!browserClosed && ws.readyState===WebSocket.OPEN){
                ws.send(Buffer.from(parsed.dataBase64,'base64'),{binary:parsed.binary});
              }
            }
          })()
            .catch(error=>{gatewayLog.error({err:error,event:'workspace_gateway_pump_failed',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway websocket pump failed');if(ws.readyState===WebSocket.OPEN)ws.close(1011,'gateway relay failed');})
            .finally(()=>{pumpBusy=false;});
        },20);
        let browserSendChain:Promise<void>=setup.then(()=>undefined);
        ws.on('message',(data:WebSocket.Data,binaryMetadata?:boolean)=>{
          if(browserClosed)return;
          const isBinary=websocketMessageIsBinary(data,binaryMetadata);
          let frame:Buffer;
          try{frame=websocketDataToBuffer(data);}catch(error){gatewayLog.error({err:error,event:'workspace_gateway_browser_frame_invalid',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway browser frame invalid');browserClosed=true;clearInterval(pump);if(ws.readyState===WebSocket.OPEN)ws.close(1003,'unsupported websocket frame');return;}
          if(!browserGatewayFrameAllowed(row.runtimeBackend,isBinary,frame.length)){
            gatewayLog.warn({event:'windows_native_browser_input_rejected',sessionId,machineId:row.machineId,channel:channelLogId,frameBytes:frame.length,binary:isBinary,frameKind:isBinary?'binary':'text'},'windows native browser input rejected');
            browserClosed=true;clearInterval(pump);if(ws.readyState===WebSocket.OPEN)ws.close(1003,'invalid native input frame');return;
          }
          if(frame.length>WS_MAX_FRAME_BYTES||!browserPending.tryAcquire(frame.length)){
            gatewayLog.error({event:'workspace_gateway_browser_send_backpressure',sessionId,machineId:row.machineId,channel:channelLogId,frameBytes:frame.length,pending:browserPending.snapshot()},'workspace gateway browser send queue exceeded');
            browserClosed=true;clearInterval(pump);if(ws.readyState===WebSocket.OPEN)ws.close(1013,'gateway backpressure');return;
          }
          const relay:RelayRequest={id:crypto.randomUUID(),sessionId,kind:'ws_send',channelId,dataBase64:frame.toString('base64'),binary:isBinary};
          const task=browserSendChain.then(async()=>{
            const accepted=nativeChannel
              ? (!browserClosed&&await enqueueAuthorizedNativeMachineRelay(db,redis,sessionId,browser.userId,row.machineId,row.runtimeBackend,channelId,channelBinding,browserSessionKey,relay))
              : (!browserClosed&&await enqueueMachineRelay(redis,row.machineId,relay));
            if(!accepted&&nativeChannel){
              browserClosed=true;clearInterval(pump);nativeLease?.invalidate();
              if(ws.readyState===WebSocket.OPEN)ws.close(1008,'workspace session expired');
              return;
            }
            if(!accepted)throw new Error('workspace_machine_queue_backpressure');
          });
          browserSendChain=task.finally(()=>browserPending.release(frame.length)).catch(error=>{
            gatewayLog.error({err:error,event:'workspace_gateway_send_failed',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway browser frame relay failed');
            if(!browserClosed){browserClosed=true;clearInterval(pump);if(ws.readyState===WebSocket.OPEN)ws.close(1013,'gateway relay backpressure');}
          });
        });
        ws.on('close',(closeCode:number,closeReason:Buffer)=>{
          browserClosed=true;clearInterval(pump);nativeLease?.invalidate();
          // Fence native upstream media immediately; waiting for a queued
          // browserSendChain must not keep the Redis channel lease alive.
          if(nativeChannel)void redis.del(wsChannelKey(channelId),wsUpstreamReadyKey(channelId))
            .catch(error=>gatewayLog.error({err:error,event:'workspace_gateway_close_fence_failed'},'native channel fence failed'));
          // Close reason may be supplied by a remote peer: never log its raw contents.
          // The code, reason length and buffered bytes are sufficient to correlate
          // a browser disconnect with gateway backpressure and Agent ws_close.
          gatewayLog.info({event:'workspace_gateway_browser_closed',sessionId,machineId:row.machineId,channel:channelLogId,closeCode,closeReasonBytes:closeReason.length,bufferedAmount:ws.bufferedAmount},'workspace gateway browser websocket closed');
          void browserSendChain.then(async()=>{
            if(!await enqueueMachineRelay(redis,row.machineId,{id:crypto.randomUUID(),sessionId,kind:'ws_close',channelId} satisfies RelayRequest))throw new Error('workspace_machine_queue_backpressure');
            await redis.del(wsChannelKey(channelId),wsUpstreamReadyKey(channelId),wsInputKey(channelId),wsInputBytesKey(channelId));
          }).catch(error=>gatewayLog.error({err:error,event:'workspace_gateway_close_cleanup_failed',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway close cleanup failed'));
        });
      });
    }catch(error){
      app.log.error({err:error,event:'workspace_gateway_upgrade_failed',sessionId},'workspace gateway upgrade failed');
      rejectWebSocketUpgrade(socket as Socket,500,'workspace_gateway_upgrade_failed');
    }
  });
}
