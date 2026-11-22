Warning: truncated output (original token count: 23901)
Total output lines: 1276

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
const PRIVATE_WINDOWS_QUALIFICATION_EVENT='WINDOWS_NATIVE_QUALIFICATION_REQUESTED';
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
-- The durable receipt is the session authority generation. A stale database
-- read cannot enqueue after STOP replaces this key with a tombstone. The first
-- frame is admitted only while no authority/tombstone exists. Activated frames
-- install their committed receipt separately after a bounded PostgreSQL read;
-- an enqueue script must never resurrect an absent authority generation.
local authority = redis.call('GET', KEYS[6])
if ARGV[10] ~= '*' then
  if ARGV[10] == '' then
    if authority then return -2 end
  else
    if authority ~= ARGV[10] then return -2 end
  end
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
local authority = redis.call('GET', KEYS[5])
if ARGV[8] ~= '*' then
  if ARGV[8] == '' then
    if authority then return -2 end
  else
    if authority ~= ARGV[8] then return -2 end
  end
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

const INSTALL_GATEWAY_AUTHORITY_SCRIPT=`
local current = redis.call('GET', KEYS[1])
-- '1' is the pre-generation activation hint. Migrate it only after the caller
-- has obtained a fresh bounded PostgreSQL snapshot containing this receipt.
if current and current ~= ARGV[1] and current ~= '1' then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

const MARK_GATEWAY_FRAME_ACCEPTED_SCRIPT=`
-- Do not refresh the short authority lease here: doing so on every frame would
-- prevent periodic PostgreSQL revalidation. STOP between enqueue and this mark
-- also suppresses publication of a fresh upstream-ready hint.
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
-- A Redis-only hot-path admission has no fresh database expiry snapshot. It
-- must still publish legacy readiness, but it may only inherit the shorter of
-- the already-bounded browser and channel TTLs; it must not refresh either key.
if ARGV[2] == '0' then
  local browserTtlMs = redis.call('PTTL', KEYS[2])
  local channelTtlMs = redis.call('PTTL', KEYS[4])
  if browserTtlMs <= 0 or channelTtlMs <= 0 then return 0 end
  redis.call('SET', KEYS[3], '1', 'PX', math.min(browserTtlMs, channelTtlMs))
  return 1
end
redis.call('EXPIRE', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], '1', 'EX', ARGV[2])
redis.call('EXPIRE', KEYS[4], ARGV[2])
return 1
`;

const REVOKE_GATEWAY_AUTHORITY_SCRIPT=`
local current = redis.call('GET', KEYS[1])
if current and string.sub(current, 1, string.len(ARGV[1])) == ARGV[1] then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  return 1
end
redis.call('SET', KEYS[1], ARGV[1] .. ARGV[2], 'EX', ARGV[3])
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
const GATEWAY_AUTHORITY_REVOKED_PREFIX='revoked:';
const GATEWAY_AUTHORITY_ID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GATEWAY_AUTHORITY_LEASE_SECONDS=2;
const GATEWAY_AUTHORITY_QUERY_TIMEOUT_MS=4_000;
const GATEWAY_AUTHORITY_REDIS_TIMEOUT_MS=5_000;

async function boundedGatewayRedis<T>(operation:PromiseLike<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([
    Promise.resolve(operation),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('gateway_authority_redis_timeout')),GATEWAY_AUTHORITY_REDIS_TIMEOUT_MS);}),
  ]);}finally{if(timer!==undefined)clearTimeout(timer);}
}

function gatewaySessionTtl(expiresAt?:Date):number{
  if(!expiresAt)return SESSION_TTL_SECONDS;
  return Math.max(1,Math.min(SESSION_TTL_SECONDS,Math.ceil((expiresAt.getTime()-Date.now())/1000)));
}

function gatewayAuthorityLeaseTtl(expiresAt?:Date):number{
  return Math.min(GATEWAY_AUTHORITY_LEASE_SECONDS,gatewaySessionTtl(expiresAt));
}

function gatewayAuthorityTombstoneTtl(expiresAt?:Date):number{
  // This is much longer than the bounded DB read. A query that began before
  // STOP cannot outlive the tombstone and reinstall its stale receipt.
  return Math.max(60,gatewaySessionTtl(expiresAt));
}

async function installGatewayAuthority(redis:Redis,sessionId:string,authorityId:string,expiresAt?:Date):Promise<boolean>{
  return Number(await boundedGatewayRedis(redis.eval(
    INSTALL_GATEWAY_AUTHORITY_SCRIPT,1,wsSessionActivatedKey(sessionId),authorityId,String(gatewayAuthorityLeaseTtl(expiresAt)),
  )))===1;
}

export async function revokeGatewayAuthority(redis:Redis,sessionId:string,expiresAt?:Date):Promise<void>{
  await boundedGatewayRedis(redis.eval(
    REVOKE_GATEWAY_AUTHORITY_SCRIPT,1,wsSessionActivatedKey(sessionId),
    GATEWAY_AUTHORITY_REVOKED_PREFIX,crypto.randomUUID(),String(gatewayAuthorityTombstoneTtl(expiresAt)),
  ));
}

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
export async function activeGatewaySession(db:PrismaClient,sessionId:string){return db.workspaceSession.findFirst({where:{id:sessionId,runtimeBackend:{in:gatewayRuntimeBackends()},status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},expiresAt:{gt:new Date()},machine:{connectivity:MachineConnectivity.ONLINE,moderationStatus:ModerationStatus.CLEAR},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}},events:{none:{action:PRIVATE_WINDOWS_QUALIFICATION_EVENT}}},select:{id:true,renterId:true,machineId:true,bookingId:true,jobId:true,status:true,expiresAt:true,runtimeBackend:true,connectionMetadata:true,machineWorkspace:{select:{workspace:{select:{slug:true}}}}}});}

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
  options:{lockSessionForMutation?:boolean;allowPreparing?:boolean}={},
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
        AND (ws."status"::text IN ('READY','RUNNING') OR (${options.allowPreparing===true} AND ws."status"::text='PREPARING'))
        AND ws."expiresAt">clock_timestamp()
        AND m."connectivity"::text='ONLINE'
        AND m."moderationStatus"::text='CLEAR'
        AND w."slug" IN (${Prisma.join(GATEWAY_WORKSPACE_SLUGS)})
        AND NOT EXISTS (
          SELECT 1 FROM "WorkspaceSessionEvent" AS qualification_event
          WHERE qualification_event."sessionId"=ws."id"
            AND qualification_event."action"=${PRIVATE_WINDOWS_QUALIFICATION_EVENT}
        )
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
export async function markNativeGatewayRev…11901 tokens truncated…eued;
    if(enqueued===-2)return close?{ok:true,stale:true}:reply.code(409).send({error:'unknown_gateway_channel'});
    if(enqueued===-1)return reply.code(429).send({error:'workspace_ws_browser_backpressure'});
    if(close)await redis.del(wsChannelKey(channelId),wsUpstreamReadyKey(channelId));
    else if(enqueued===1)await markAcceptedGatewayFrame(redis,binding.sessionId,channelId,binding,acceptedFrame.authorityId,acceptedFrame.expiresAt);
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
    // Even a failed cleanup is a committed terminal transition: the session
    // is QUARANTINED in PostgreSQL. Publish its Redis tombstone before
    // returning the 409, just as for a successful stop. Otherwise a short
    // native authority lease could survive the failure acknowledgement.
    if('error' in result && result.error!=='workspace_cleanup_unverified')
      return reply.code(409).send({error:result.error});
    await revokeGatewayAuthority(redis,sessionId);
    if('error' in result)return reply.code(409).send({error:result.error});
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
