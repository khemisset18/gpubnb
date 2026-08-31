import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BookingStatus, JobStatus, MachineConnectivity, MachineOperational, ModerationStatus, PaymentStatus, Prisma, SessionTerminationReason, WorkspaceSessionStatus, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import WebSocket from 'ws';
import { dataPlaneHostBootstrapEnabled, issueHostTunnelBootstrap, loadDataPlaneHostRuntimeConfig } from './data-plane-host-bootstrap.js';
import { verifyAgentRequest, verifyAgentRequestV2 } from './security.js';
import { consumeWorkspaceAccessGrant } from './workspace-access.js';
import { waitForGatewayQueueItem } from './gateway-queue.js';
import {
  BrowserPendingBudget,
  WS_BROWSER_BACKPRESSURE_TIMEOUT_MS,
  WS_BROWSER_BUFFERED_HIGH_WATER_BYTES,
  WS_MACHINE_QUEUE_MAX_BYTES,
  WS_REDIS_INPUT_MAX_BYTES,
  isStrictBase64Payload,
  websocketDataToBuffer,
} from './workspace-gateway-transport.js';

const WebSocketServer=WebSocket.Server;
// Every workspace this gateway can actually run a persistent container+browser
// session for. Kept as a plain literal (not imported from
// machine-workspace-catalog's executableWorkspaceSlugs) because that list also
// includes 'compute', which never runs through this gateway at all (it's a
// one-shot batch job - see agent/gpubnb_agent/runner.py's GPU_PROOF path).
const GATEWAY_WORKSPACE_SLUGS:string[]=['developer','data','ai','video'];
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
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
local count = redis.call('LLEN', KEYS[2])
local currentBytes = tonumber(redis.call('GET', KEYS[3]) or '0')
local itemBytes = tonumber(ARGV[4])
if count >= tonumber(ARGV[5]) or currentBytes + itemBytes > tonumber(ARGV[6]) then
  return -1
end
if redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX') then
  redis.call('LPUSH', KEYS[2], ARGV[3])
  redis.call('SET', KEYS[3], currentBytes + itemBytes, 'EX', ARGV[2])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  return 1
end
return 0
`;

type RelayRequest={id:string;sessionId:string;kind:'http'|'ws_open'|'ws_send'|'ws_close';method?:string;path?:string;headers?:Record<string,string>;bodyBase64?:string;channelId?:string;dataBase64?:string;binary?:boolean};
type RelayResponse={status:number;headers?:Record<string,string>;bodyBase64?:string;error?:string};
type GatewayChannelBinding={sessionId:string;machineId:string;browserSessionKey:string};
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
async function activeGatewaySession(db:PrismaClient,sessionId:string){return db.workspaceSession.findFirst({where:{id:sessionId,status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},expiresAt:{gt:new Date()},machine:{connectivity:MachineConnectivity.ONLINE,moderationStatus:ModerationStatus.CLEAR}},select:{id:true,renterId:true,machineId:true,bookingId:true,status:true,expiresAt:true,connectionMetadata:true,machineWorkspace:{select:{workspace:{select:{slug:true}}}}}});}

async function activateGatewaySession(db:PrismaClient,sessionId:string,machineId:string){
  return db.$transaction(async tx=>{
    const row=await tx.workspaceSession.findFirst({
      where:{id:sessionId,machineId,status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},expiresAt:{gt:new Date()},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},
      select:{id:true,bookingId:true,status:true,expiresAt:true,booking:{select:{status:true,expectedSeconds:true}}},
    });
    if(!row)return null;
    if(row.status===WorkspaceSessionStatus.RUNNING&&row.booking.status===BookingStatus.ACTIVE)return {activated:false,expiresAt:row.expiresAt};
    if(row.status!==WorkspaceSessionStatus.READY||row.booking.status!==BookingStatus.STARTING)return null;
    const activatedAt=new Date();const expiresAt=new Date(activatedAt.getTime()+row.booking.expectedSeconds*1000);
    const sessionUpdate=await tx.workspaceSession.updateMany({where:{id:row.id,status:WorkspaceSessionStatus.READY},data:{status:WorkspaceSessionStatus.RUNNING,startedAt:activatedAt,expiresAt,preparationStep:'INTERACTIVE_WORKSPACE_CONNECTED'}});
    if(sessionUpdate.count!==1){
      const winner=await tx.workspaceSession.findFirst({where:{id:row.id,machineId,status:WorkspaceSessionStatus.RUNNING,booking:{status:BookingStatus.ACTIVE}},select:{expiresAt:true}});
      return winner?{activated:false,expiresAt:winner.expiresAt}:null;
    }
    const bookingUpdate=await tx.booking.updateMany({where:{id:row.bookingId,status:BookingStatus.STARTING},data:{status:BookingStatus.ACTIVE,startsAt:activatedAt,endsAt:expiresAt}});
    if(bookingUpdate.count!==1)throw new Error('workspace_activation_booking_conflict');
    await tx.machineAllocation.updateMany({where:{bookingId:row.bookingId},data:{startsAt:activatedAt,endsAt:expiresAt}});
    await tx.acceleratorAllocation.updateMany({where:{bookingId:row.bookingId},data:{startsAt:activatedAt,endsAt:expiresAt}});
    await tx.workspaceSessionEvent.create({data:{sessionId:row.id,actorType:'RENTER',action:'INTERACTIVE_WORKSPACE_CONNECTED'}});
    return {activated:true,expiresAt};
  });
}

export function registerWorkspaceGatewayRoutes(app:FastifyInstance,db:PrismaClient,redis:Redis):void{
  app.get('/workspace-gateway/:sessionId',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');const grant=String((request.query as {grant?:string}).grant||'');const consumed=await consumeWorkspaceAccessGrant(redis,grant);
    if(!consumed||consumed.sessionId!==sessionId)return reply.code(401).send({error:'invalid_workspace_grant'});const row=await activeGatewaySession(db,sessionId);if(!row||row.renterId!==consumed.userId)return reply.code(409).send({error:'workspace_not_available'});
    const browserToken=crypto.randomBytes(32).toString('base64url');const ttl=Math.max(30,Math.min(SESSION_TTL_SECONDS,Math.floor((row.expiresAt.getTime()-Date.now())/1000)));await redis.set(gatewaySessionKey(browserToken),JSON.stringify({userId:row.renterId,sessionId}),'EX',ttl);
    // Consuming a grant only authenticates the browser. Billing and the purchased
    // duration start later, after the agent proves that code-server exchanged a
    // real WebSocket frame with this authenticated browser.
    // Entry comes from the Netlify renter portal. Lax is required for the cookie
    // to survive that top-level cross-site navigation and its same-origin redirect;
    // HttpOnly, Secure and the per-session Path keep it scoped to this gateway.
    reply.setCookie(GATEWAY_COOKIE,browserToken,{httpOnly:true,secure:true,sameSite:'lax',path:`/workspace-gateway/${sessionId}`});return reply.redirect(`/workspace-gateway/${sessionId}/`);
  });
  app.all('/workspace-gateway/:sessionId/*',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');const token=parseCookie(request.headers.cookie,GATEWAY_COOKIE);if(!token)return reply.code(401).send({error:'workspace_auth_required'});const raw=await redis.get(gatewaySessionKey(token));if(!raw)return reply.code(401).send({error:'workspace_session_expired'});const browser=JSON.parse(raw) as {userId:string;sessionId:string};if(browser.sessionId!==sessionId)return reply.code(403).send({error:'workspace_session_mismatch'});const row=await activeGatewaySession(db,sessionId);if(!row||row.renterId!==browser.userId)return reply.code(409).send({error:'workspace_not_available'});
    const suffix='/'+String((request.params as {'*'?:string})['*']||'');const query=request.url.includes('?')?'?'+request.url.split('?').slice(1).join('?'):'';const targetPath=`${suffix}${query}`;if(!safePath(targetPath))return reply.code(400).send({error:'invalid_gateway_path'});const body=request.rawBody??Buffer.alloc(0);if(body.length>10*1024*1024)return reply.code(413).send({error:'gateway_body_too_large'});
    const id=crypto.randomUUID();const relay:RelayRequest={id,sessionId,kind:'http',method:request.method,path:targetPath,headers:relayHeaders(request.headers as Record<string,unknown>),bodyBase64:body.toString('base64')};if(!await enqueueMachineRelay(redis,row.machineId,relay))return reply.code(503).send({error:'workspace_gateway_backpressure'});const result=await waitJson(redis,responseKey(id));if(!result)return reply.code(504).send({error:'workspace_gateway_timeout'});for(const [name,value] of Object.entries(result.headers||{})){if(SAFE_RESPONSE_HEADERS.has(name.toLowerCase()))reply.header(name,value);}if(result.error)return reply.code(502).send({error:'workspace_upstream_error'});return reply.code(Math.max(100,Math.min(599,result.status||502))).send(Buffer.from(result.bodyBase64||'','base64'));
  });
  app.get('/agent/workspace-gateway/:machineId/desired',async(request,reply)=>{
    const machineId=String((request.params as {machineId?:string}).machineId||'');const route=`/agent/workspace-gateway/${machineId}/desired`;if(!await authenticateAgent(db,redis,machineId,request,route))return reply.code(401).send({error:'invalid_agent_request'});
    const rows=await db.workspaceSession.findMany({where:{machineId,status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING,WorkspaceSessionStatus.STOP_REQUESTED,WorkspaceSessionStatus.STOPPING]},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,status:true,expiresAt:true,connectionMetadata:true,machineWorkspace:{select:{workspace:{select:{slug:true}}}}}});
    // The agent needs to know which container/image to run per session - a
    // flat workspaceSlug is what workspace_gateway.py's _reconcile_sessions
    // reads (defaulting to 'developer' for any older/unrecognized value).
    const sessions=rows.map(({machineWorkspace,...row})=>({...row,workspaceSlug:machineWorkspace.workspace.slug}));
    return {sessions,dataPlane:{hostTunnelEnabled:dataPlaneHostBootstrapEnabled()}};
  });
  app.get('/agent/workspace-gateway/:machineId/sessions/:sessionId/data-plane-host',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(request,reply)=>{
    const params=request.params as {machineId?:string;sessionId?:string};const machineId=String(params.machineId||'');const sessionId=String(params.sessionId||'');const route=`/agent/workspace-gateway/${machineId}/sessions/${sessionId}/data-plane-host`;if(!await authenticateAgent(db,redis,machineId,request,route))return reply.code(401).send({error:'invalid_agent_request'});
    const runtime=loadDataPlaneHostRuntimeConfig();if(!runtime)return reply.code(404).send({error:'data_plane_disabled'});
    const row=await db.workspaceSession.findFirst({where:{id:sessionId,machineId,status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},expiresAt:{gt:new Date()},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,machineId:true,bookingId:true,renterId:true}});if(!row)return reply.code(404).send({error:'workspace_session_not_available'});
    return issueHostTunnelBootstrap(runtime,{sessionId:row.id,machineId:row.machineId,bookingId:row.bookingId,renterUserId:row.renterId});
  });
  app.get('/agent/workspace-gateway/:machineId/next',{config:{rateLimit:{max:AGENT_TUNNEL_RATE_LIMIT_PER_MINUTE,timeWindow:'1 minute'}}},async(request,reply)=>{const machineId=String((request.params as {machineId?:string}).machineId||'');const route=`/agent/workspace-gateway/${machineId}/next`;if(!await authenticateAgent(db,redis,machineId,request,route))return reply.code(401).send({error:'invalid_agent_request'});const raw=await waitForGatewayQueueItem(redis,machineQueue(machineId));if(!raw)return reply.code(204).send();await accountDequeuedBytes(redis,machineQueueBytesKey(machineId),raw,MACHINE_QUEUE_TTL_SECONDS);return JSON.parse(raw);});
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
    return {items};
  });
  app.post('/agent/workspace-gateway/:sessionId/register',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');const body=request.body as {machineId?:string;runtimeId?:string;localPort?:number};const machineId=String(body.machineId||'');const route=`/agent/workspace-gateway/${sessionId}/register`;if(!await authenticateAgent(db,redis,machineId,request,route,true))return reply.code(401).send({error:'invalid_agent_request'});if(!/^[a-zA-Z0-9_.-]{6,100}$/.test(String(body.runtimeId||''))||!Number.isInteger(body.localPort)||Number(body.localPort)<1024||Number(body.localPort)>65535)return reply.code(400).send({error:'invalid_runtime_registration'});
    const row=await db.workspaceSession.findFirst({where:{id:sessionId,machineId,status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,status:true,bookingId:true,connectionMetadata:true,booking:{select:{expectedSeconds:true}}}});if(!row)return reply.code(409).send({error:'workspace_not_registerable'});
    const metadata=row.connectionMetadata&&typeof row.connectionMetadata==='object'?row.connectionMetadata as Record<string,unknown>:null;
    const firstRegistration=row.status===WorkspaceSessionStatus.READY&&typeof metadata?.gatewayPath!=='string';
    const readyAt=new Date();const activationDeadline=new Date(readyAt.getTime()+INTERACTIVE_CONNECT_TIMEOUT_SECONDS*1000);
    await db.$transaction([
      db.workspaceSession.update({where:{id:row.id},data:{connectionType:'GPUbnbGateway',connectionMetadata:{gatewayPath:`/workspace-gateway/${sessionId}`,runtimeId:String(body.runtimeId),localPort:Number(body.localPort)},...(firstRegistration?{readyAt,startedAt:null,expiresAt:activationDeadline,preparationProgress:100,preparationStep:'WAITING_FOR_INTERACTIVE_CONNECTION'}:{}),events:{create:{actorType:'AGENT',actorId:machineId,action:'GATEWAY_READY'}}}}),
      ...(firstRegistration?[
        db.booking.updateMany({where:{id:row.bookingId,status:BookingStatus.FUNDED},data:{status:BookingStatus.STARTING,startsAt:readyAt,endsAt:activationDeadline}}),
        db.machineAllocation.updateMany({where:{bookingId:row.bookingId},data:{startsAt:readyAt,endsAt:activationDeadline}}),
        db.acceleratorAllocation.updateMany({where:{bookingId:row.bookingId},data:{startsAt:readyAt,endsAt:activationDeadline}}),
      ]:[]),
    ]);
    return {ok:true,gatewayPath:`/workspace-gateway/${sessionId}`};
  });
  app.post('/agent/workspace-gateway/:sessionId/usage',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');
    const body=request.body as {machineId?:string;counter?:string;intervalSeconds?:number;available?:boolean};
    const machineId=String(body.machineId||'');const route=`/agent/workspace-gateway/${sessionId}/usage`;
    if(!await authenticateAgent(db,redis,machineId,request,route,true))return reply.code(401).send({error:'invalid_agent_request'});
    if(!/^\d{1,20}$/.test(String(body.counter||''))||!Number.isInteger(body.intervalSeconds)||Number(body.intervalSeconds)<1||Number(body.intervalSeconds)>30||body.available!==true)return reply.code(400).send({error:'invalid_usage_sample'});
    const counter=BigInt(String(body.counter));
    const row=await db.workspaceSession.findFirst({where:{id:sessionId,machineId,status:{in:[WorkspaceSessionStatus.READY,WorkspaceSessionStatus.RUNNING]},readyAt:{not:null},machineWorkspace:{workspace:{slug:{in:GATEWAY_WORKSPACE_SLUGS}}}},select:{id:true,status:true,bookingId:true,lastMetricCounter:true,booking:{select:{status:true,validSeconds:true,expectedSeconds:true}}}});
    if(!row)return reply.code(409).send({error:'workspace_not_billable'});
    const pendingActivation=row.status===WorkspaceSessionStatus.READY&&row.booking.status===BookingStatus.STARTING;
    const billable=row.status===WorkspaceSessionStatus.RUNNING&&row.booking.status===BookingStatus.ACTIVE;
    if(!pendingActivation&&!billable)return reply.code(409).send({error:'workspace_not_billable'});
    if(counter<=row.lastMetricCounter)return reply.code(409).send({error:'usage_counter_replay'});
    if(pendingActivation){
      await db.workspaceSession.update({where:{id:row.id},data:{lastMetricCounter:counter}});
      return {ok:true,validIncrement:0,pendingActivation:true};
    }
    const increment=Math.min(Number(body.intervalSeconds),Math.max(0,row.booking.expectedSeconds-row.booking.validSeconds));
    await db.$transaction([
      db.workspaceSession.update({where:{id:row.id},data:{lastMetricCounter:counter}}),
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
      let ttl=WS_INPUT_TTL_SECONDS;
      if(!close){
        const activatedKey=wsSessionActivatedKey(binding.sessionId);ttl=await redis.ttl(activatedKey);
        if(ttl<1){
          const activation=await activateGatewaySession(db,binding.sessionId,machineId);if(!activation)return reply.code(409).send({error:'interactive_workspace_not_activatable'});
          ttl=Math.max(30,Math.min(SESSION_TTL_SECONDS,Math.ceil((activation.expiresAt.getTime()-Date.now())/1000)));
          await redis.set(activatedKey,'1','EX',ttl);await redis.expire(binding.browserSessionKey,ttl);
        }
        await redis.set(wsUpstreamReadyKey(channelId),'1','EX',ttl);await redis.expire(wsChannelKey(channelId),ttl);
      }
      const relayPayload=JSON.stringify({dataBase64,binary:frame.binary===true,close});
      const relayBytes=Buffer.byteLength(relayPayload,'utf8');
      const enqueued=Number(await redis.eval(ENQUEUE_DEDUPED_WS_FRAME_SCRIPT,3,markerKey,wsInputKey(channelId),wsInputBytesKey(channelId),String(WS_FRAME_DEDUPE_TTL_SECONDS),String(WS_INPUT_TTL_SECONDS),relayPayload,String(relayBytes),String(WS_INPUT_MAX_ITEMS),String(WS_REDIS_INPUT_MAX_BYTES)));
      if(enqueued===-1)return reply.code(429).send({error:'workspace_ws_browser_backpressure'});
      if(enqueued===1){accepted++;if(close)await redis.del(wsChannelKey(channelId),wsUpstreamReadyKey(channelId));}else{duplicates++;}
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
    if(!close){
      // A real upstream frame remains the billing activation signal. Cache that
      // session-level activation in Redis so the VS Code protocol hot path does
      // not run a PostgreSQL transaction for every Management/ExtensionHost frame.
      const activatedKey=wsSessionActivatedKey(binding.sessionId);
      let ttl=await redis.ttl(activatedKey);
      if(ttl<1){
        const activation=await activateGatewaySession(db,binding.sessionId,machineId);if(!activation)return reply.code(409).send({error:'interactive_workspace_not_activatable'});
        ttl=Math.max(30,Math.min(SESSION_TTL_SECONDS,Math.ceil((activation.expiresAt.getTime()-Date.now())/1000)));
        await redis.set(activatedKey,'1','EX',ttl);await redis.expire(binding.browserSessionKey,ttl);
      }
      // Channel readiness is intentionally separate from session activation:
      // ws_open ACKs may prove a local socket exists, but only a real frame may
      // activate billing. Legacy agents still use this first-frame readiness key.
      await redis.set(wsUpstreamReadyKey(channelId),'1','EX',ttl);await redis.expire(wsChannelKey(channelId),ttl);
    }
    const relayPayload=JSON.stringify({dataBase64,binary:body.binary===true,close});
    if(!await enqueueBoundedList(redis,wsInputKey(channelId),wsInputBytesKey(channelId),relayPayload,WS_INPUT_TTL_SECONDS,WS_INPUT_MAX_ITEMS,WS_REDIS_INPUT_MAX_BYTES))return reply.code(429).send({error:'workspace_ws_browser_backpressure'});
    if(close)await redis.del(wsChannelKey(channelId),wsUpstreamReadyKey(channelId));
    return {ok:true};
  });
  app.post('/agent/workspace-gateway/:sessionId/stopped',async(request,reply)=>{
    const sessionId=String((request.params as {sessionId?:string}).sessionId||'');const body=request.body as {machineId?:string;cleaned?:boolean};const machineId=String(body.machineId||'');const route=`/agent/workspace-gateway/${sessionId}/stopped`;if(!await authenticateAgent(db,redis,machineId,request,route,true))return reply.code(401).send({error:'invalid_agent_request'});
    if(body.cleaned!==true){await db.machine.update({where:{id:machineId},data:{moderationStatus:ModerationStatus.QUARANTINED,operational:MachineOperational.UNAVAILABLE}});await db.workspaceSession.updateMany({where:{id:sessionId,machineId},data:{status:WorkspaceSessionStatus.QUARANTINED,endedAt:new Date()}});return reply.code(409).send({error:'workspace_cleanup_unverified'});}
    const row=await db.workspaceSession.findFirst({where:{id:sessionId,machineId,status:{in:[WorkspaceSessionStatus.STOP_REQUESTED,WorkspaceSessionStatus.STOPPING,WorkspaceSessionStatus.RUNNING,WorkspaceSessionStatus.READY]}},select:{id:true,bookingId:true,startedAt:true}});if(!row)return reply.code(409).send({error:'workspace_not_stoppable'});
    const neverActivated=row.startedAt===null;const endedAt=new Date();
    const release=await db.$transaction(async tx=>{
      await tx.workspaceSession.update({where:{id:row.id},data:{status:neverActivated?WorkspaceSessionStatus.TIMED_OUT:WorkspaceSessionStatus.COMPLETED,endedAt,connectionMetadata:{},...(neverActivated?{terminationReason:SessionTerminationReason.TIMEOUT,preparationStep:'INTERACTIVE_CONNECTION_TIMEOUT'}:{}),events:{create:{actorType:'AGENT',actorId:machineId,action:neverActivated?'INTERACTIVE_CONNECTION_NEVER_ESTABLISHED':'GATEWAY_CLEANUP_VERIFIED'}}}});
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
      return machineUpdate.count===1;
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    await redis.del(wsSessionActivatedKey(sessionId));
    return {ok:true,activated:!neverActivated,machineReleased:release};
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
    const sessionId=match[1];const token=parseCookie(request.headers.cookie,GATEWAY_COOKIE);
    app.log.info({event:'workspace_gateway_upgrade_received',sessionId,hasWorkspaceCookie:!!token},'workspace gateway upgrade received');
    if(!token){app.log.warn({event:'workspace_gateway_upgrade_rejected',sessionId,reason:'cookie_missing'},'workspace gateway upgrade rejected');rejectWebSocketUpgrade(socket as Socket,401,'workspace_auth_required');return;}

    try{
      const raw=await redis.get(gatewaySessionKey(token));
      if(!raw){app.log.warn({event:'workspace_gateway_upgrade_rejected',sessionId,reason:'cookie_expired'},'workspace gateway upgrade rejected');rejectWebSocketUpgrade(socket as Socket,401,'workspace_session_expired');return;}
      const browser=JSON.parse(raw) as {userId:string;sessionId:string};
      if(browser.sessionId!==sessionId){app.log.warn({event:'workspace_gateway_upgrade_rejected',sessionId,reason:'session_mismatch'},'workspace gateway upgrade rejected');rejectWebSocketUpgrade(socket as Socket,403,'workspace_session_mismatch');return;}
      const row=await activeGatewaySession(db,sessionId);
      if(!row||row.renterId!==browser.userId){app.log.warn({event:'workspace_gateway_upgrade_rejected',sessionId,reason:'workspace_unavailable'},'workspace gateway upgrade rejected');rejectWebSocketUpgrade(socket as Socket,409,'workspace_not_available');return;}

      wss.handleUpgrade(request,socket as Socket,head,(ws:WebSocket)=>{
        const channelId=crypto.randomUUID();const channelLogId=channelId.slice(0,8);const targetPath='/'+match[2]+url.search;const browserSessionKey=gatewaySessionKey(token);
        const channelTtl=Math.max(30,Math.min(SESSION_TTL_SECONDS,Math.ceil((row.expiresAt.getTime()-Date.now())/1000)));
        const openRequestId=crypto.randomUUID();let browserClosed=false;let browserBackpressureSince=0;
        const browserPending=new BrowserPendingBudget();
        app.log.info({event:'workspace_gateway_browser_connected',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway browser websocket connected');
        ws.on('error',error=>app.log.warn({err:error,event:'workspace_gateway_browser_socket_error',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway browser websocket error'));
        // Keep queue ordering backward-compatible: browser frames may be queued as
        // soon as ws_open itself is enqueued. LPUSH/RPOP preserves ws_open before
        // ws_send, so legacy agents can still establish code-server and exchange
        // their first frame while newer agents additionally return an explicit ACK.
        const setup=(async()=>{
          await redis.set(wsChannelKey(channelId),JSON.stringify({sessionId,machineId:row.machineId,browserSessionKey} satisfies GatewayChannelBinding),'EX',channelTtl);
          const accepted=await enqueueMachineRelay(redis,row.machineId,{id:openRequestId,sessionId,kind:'ws_open',channelId,path:targetPath,headers:relayHeaders(request.headers as Record<string,unknown>)} satisfies RelayRequest);
          if(!accepted)throw new Error('workspace_machine_queue_backpressure');
        })();
        const upstreamProbe=setup.then(async()=>{
          const opened=await waitJson(redis,responseKey(openRequestId),WS_UPSTREAM_OPEN_TIMEOUT_MS);
          if(browserClosed)return;
          if(opened){
            if(opened.error||opened.status!==101)throw new Error(`workspace_upstream_open_failed:${opened.error||opened.status}`);
            await redis.set(wsUpstreamReadyKey(channelId),'1','EX',channelTtl);
            app.log.info({event:'workspace_gateway_upstream_opened',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway upstream websocket opened');
            return;
          }
          // Old agents do not answer ws_open. Preserve their previous behavior:
          // a signed first upstream frame proves the local WebSocket is alive.
          const legacyReady=await redis.get(wsUpstreamReadyKey(channelId));
          if(browserClosed)return;
          if(legacyReady){app.log.info({event:'workspace_gateway_legacy_upstream_ready',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway legacy agent produced an upstream frame');return;}
          throw new Error('workspace_upstream_open_timeout');
        });
        void upstreamProbe.catch(error=>{if(browserClosed)return;app.log.error({err:error,event:'workspace_gateway_upstream_open_failed',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway upstream websocket failed to open');if(ws.readyState===WebSocket.OPEN)ws.close(1011,'workspace upstream unavailable');});

        let pumpBusy=false;
        const pump=setInterval(()=>{
          if(pumpBusy||browserClosed)return;
          if(ws.bufferedAmount>WS_BROWSER_BUFFERED_HIGH_WATER_BYTES){
            if(browserBackpressureSince===0)browserBackpressureSince=Date.now();
            if(Date.now()-browserBackpressureSince>WS_BROWSER_BACKPRESSURE_TIMEOUT_MS){
              app.log.error({event:'workspace_gateway_browser_backpressure_timeout',sessionId,machineId:row.machineId,channel:channelLogId,bufferedAmount:ws.bufferedAmount},'workspace gateway browser backpressure timed out');
              browserClosed=true;clearInterval(pump);if(ws.readyState===WebSocket.OPEN)ws.close(1013,'browser backpressure');
            }
            return;
          }
          browserBackpressureSince=0;
          pumpBusy=true;
          void (async()=>{
            for(let i=0;i<50;i++){
              if(ws.bufferedAmount>WS_BROWSER_BUFFERED_HIGH_WATER_BYTES)break;
              const frame=await redis.rpop(wsInputKey(channelId));if(!frame)break;
              await accountDequeuedBytes(redis,wsInputBytesKey(channelId),frame,WS_INPUT_TTL_SECONDS);
              const parsed=JSON.parse(frame) as {dataBase64?:unknown;binary?:unknown;close?:unknown};
              if(parsed.close===true){if(ws.readyState===WebSocket.OPEN)ws.close(1000,'upstream closed');break;}
              if(typeof parsed.binary!=='boolean'||!isStrictBase64Payload(parsed.dataBase64,WS_MAX_BASE64_BYTES,WS_MAX_FRAME_BYTES))throw new Error('workspace_ws_redis_frame_invalid');
              if(ws.readyState===WebSocket.OPEN)ws.send(Buffer.from(parsed.dataBase64,'base64'),{binary:parsed.binary});
            }
          })()
            .catch(error=>{app.log.error({err:error,event:'workspace_gateway_pump_failed',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway websocket pump failed');if(ws.readyState===WebSocket.OPEN)ws.close(1011,'gateway relay failed');})
            .finally(()=>{pumpBusy=false;});
        },20);
        let browserSendChain:Promise<void>=setup.then(()=>undefined);
        ws.on('message',(data:WebSocket.Data,isBinary:boolean)=>{
          if(browserClosed)return;
          let frame:Buffer;
          try{frame=websocketDataToBuffer(data);}catch(error){app.log.error({err:error,event:'workspace_gateway_browser_frame_invalid',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway browser frame invalid');browserClosed=true;clearInterval(pump);if(ws.readyState===WebSocket.OPEN)ws.close(1003,'unsupported websocket frame');return;}
          if(frame.length>WS_MAX_FRAME_BYTES||!browserPending.tryAcquire(frame.length)){
            app.log.error({event:'workspace_gateway_browser_send_backpressure',sessionId,machineId:row.machineId,channel:channelLogId,frameBytes:frame.length,pending:browserPending.snapshot()},'workspace gateway browser send queue exceeded');
            browserClosed=true;clearInterval(pump);if(ws.readyState===WebSocket.OPEN)ws.close(1013,'gateway backpressure');return;
          }
          const relay:RelayRequest={id:crypto.randomUUID(),sessionId,kind:'ws_send',channelId,dataBase64:frame.toString('base64'),binary:isBinary};
          const task=browserSendChain.then(async()=>{if(!await enqueueMachineRelay(redis,row.machineId,relay))throw new Error('workspace_machine_queue_backpressure');});
          browserSendChain=task.finally(()=>browserPending.release(frame.length)).catch(error=>{
            app.log.error({err:error,event:'workspace_gateway_send_failed',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway browser frame relay failed');
            if(!browserClosed){browserClosed=true;clearInterval(pump);if(ws.readyState===WebSocket.OPEN)ws.close(1013,'gateway relay backpressure');}
          });
        });
        ws.on('close',()=>{
          browserClosed=true;clearInterval(pump);app.log.info({event:'workspace_gateway_browser_closed',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway browser websocket closed');
          void browserSendChain.then(async()=>{
            if(!await enqueueMachineRelay(redis,row.machineId,{id:crypto.randomUUID(),sessionId,kind:'ws_close',channelId} satisfies RelayRequest))throw new Error('workspace_machine_queue_backpressure');
            await redis.del(wsChannelKey(channelId),wsUpstreamReadyKey(channelId),wsInputKey(channelId),wsInputBytesKey(channelId));
          }).catch(error=>app.log.error({err:error,event:'workspace_gateway_close_cleanup_failed',sessionId,machineId:row.machineId,channel:channelLogId},'workspace gateway close cleanup failed'));
        });
      });
    }catch(error){
      app.log.error({err:error,event:'workspace_gateway_upgrade_failed',sessionId},'workspace gateway upgrade failed');
      rejectWebSocketUpgrade(socket as Socket,500,'workspace_gateway_upgrade_failed');
    }
  });
}
