import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api=fs.readFileSync(new URL('../src/workspace-gateway.ts',import.meta.url),'utf8');
const agent=fs.readFileSync(new URL('../../../agent/gpubnb_agent/workspace_gateway.py',import.meta.url),'utf8');
const transport=fs.readFileSync(new URL('../../../agent/gpubnb_agent/workspace_gateway_v2.py',import.meta.url),'utf8');

test('gateway never returns a direct host endpoint to the renter',()=>{
  assert.match(api,/\/workspace-gateway\/\$\{sessionId\}/);
  assert.doesNotMatch(api,/openPath:\s*['"`]https?:\/\//);
  assert.match(api,/GATEWAY_COOKIE/);
  assert.match(api,/httpOnly:true/);
  assert.match(api,/secure:true/);
  assert.match(api,/sameSite:'lax'/);
  assert.match(api,/bodyLimit:MAX_AGENT_RELAY_BODY_BYTES/);
  assert.match(api,/['"]accept-encoding['"]/);
  assert.match(api,/['"]content-encoding['"]/);
  assert.match(api,/workspace-gateway:ws-channel:/);
  assert.match(api,/gateway_channel_machine_mismatch/);
  assert.match(api,/INTERACTIVE_WORKSPACE_CONNECTED/);
  assert.match(api,/validIncrement:0,pendingActivation:true/);
  assert.doesNotMatch(api,/SAFE_RESPONSE_HEADERS=new Set\([^\n]*content-length/);
});

test('websocket upgrades fail explicitly and expose a minimal edge health probe',()=>{
  assert.match(api,/WS_HEALTH_PATH='\/ws-health'/);
  assert.match(api,/gpubnb-ws-ok/);
  assert.match(api,/websocketUpgradeRejection/);
  assert.match(api,/workspace_auth_required/);
  assert.match(api,/workspace_session_expired/);
  assert.match(api,/workspace_session_mismatch/);
  assert.match(api,/workspace_gateway_upgrade_rejected/);
  assert.doesNotMatch(api,/if\(!token\)\{socket\.destroy\(\)/);
});

test('browser websocket consumes an explicit signed agent open acknowledgement',()=>{
  assert.match(api,/WS_UPSTREAM_OPEN_TIMEOUT_MS/);
  assert.match(api,/openRequestId=crypto\.randomUUID\(\)/);
  assert.match(api,/waitJson\(redis,responseKey\(openRequestId\),WS_UPSTREAM_OPEN_TIMEOUT_MS\)/);
  assert.match(api,/opened\.status!==101/);
  assert.match(api,/workspace_gateway_upstream_opened/);
  assert.match(api,/workspace_gateway_upstream_open_failed/);
  assert.match(agent,/request_id = str\(item\.get\("id"\) or ""\)/);
  assert.match(agent,/"status": 101/);
  assert.match(agent,/"status": 502/);
  assert.match(agent,/"\/agent\/workspace-gateway\/respond"/);
  assert.doesNotMatch(api,/WS_UPSTREAM_FIRST_FRAME_TIMEOUT_MS/);
});

test('legacy agents retain first-upstream-frame readiness during rollout',()=>{
  assert.match(api,/workspace_gateway_legacy_upstream_ready/);
  assert.match(api,/const legacyReady=await redis\.get\(wsUpstreamReadyKey\(channelId\)\)/);
  assert.match(api,/redis\.set\(wsUpstreamReadyKey\(channelId\),'1','EX',ttl\)/);
  assert.match(api,/ws\.on\('message'/);
});

test('nonce-bound v2 auth is preferred for both GET and body relay traffic',()=>{
  assert.match(api,/const signatureVersion=Array\.isArray\(versionHeader\)\?versionHeader\[0\]:versionHeader/);
  assert.match(api,/if\(signatureVersion==='2'\)\{/);
  assert.match(api,/const bodyBytes=request\.rawBody\?\?Buffer\.alloc\(0\)/);
  assert.match(api,/return verifyAgentRequestV2\(redis,machineId,machine\.agentPublicKey/);
  assert.match(api,/if\(withBody\)return false/);
  assert.match(api,/return verifyAgentRequest\(redis,machineId,machine\.agentPublicKey/);
});

test('websocket tunnel batches both directions with bounded payloads',()=>{
  assert.match(api,/AGENT_NEXT_BATCH_MAX_ITEMS=64/);
  assert.match(api,/AGENT_NEXT_BATCH_MAX_JSON_BYTES=16\*1024\*1024/);
  assert.match(api,/AGENT_WS_FRAME_BATCH_MAX_ITEMS=32/);
  assert.match(api,/AGENT_WS_FRAME_BATCH_MAX_BASE64_BYTES=8\*1024\*1024/);
  assert.match(api,/\/next-batch'/);
  assert.match(api,/const candidateBytes=Buffer\.byteLength\(raw,'utf8'\)\+1/);
  assert.match(api,/if\(batchBytes\+candidateBytes>AGENT_NEXT_BATCH_MAX_JSON_BYTES\)\{await redis\.rpush\(queueKey,raw\);break;\}/);
  assert.match(api,/\/ws-frames'/);
  assert.match(api,/workspace_ws_frame_batch_too_large/);
  assert.match(transport,/WS_OUTBOUND_QUEUE_MAX_ITEMS = 256/);
  assert.match(transport,/WS_OUTBOUND_QUEUE_MAX_BYTES = 12 \* 1024 \* 1024/);
  assert.match(transport,/WS_FRAME_BATCH_MAX_ITEMS = 32/);
  assert.match(transport,/def _post_ws_frames/);
  assert.match(transport,/def _next_items/);
  assert.match(transport,/def _reconcile_loop/);
});

test('agent tunnel preserves long-lived websocket handshakes and absorbs startup bursts',()=>{
  assert.match(transport,/LOCAL_WS_CONNECT_TIMEOUT_SECONDS = 10\.0/);
  assert.match(transport,/set_timeout\(None\)/);
  assert.match(transport,/subprotocols=subprotocols or None/);
  assert.match(transport,/HTTP_RELAY_QUEUE_MAX_ITEMS = 128/);
  assert.match(transport,/HTTP_RELAY_MAX_RESPONSE_BYTES = 10 \* 1024 \* 1024/);
  assert.match(transport,/workspace_http_response_too_large/);
  assert.match(transport,/workspace_trace:|workspace_trace:\{event\}/);
});

test('batched upstream frames are retry-idempotent before entering browser queue',()=>{
  assert.match(api,/wsFrameSeenKey=\(machineId:string,frameId:string\)/);
  assert.match(api,/ENQUEUE_DEDUPED_WS_FRAME_SCRIPT/);
  assert.match(api,/redis\.call\('SET', KEYS\[1\], '1', 'EX', ARGV\[1\], 'NX'\)/);
  assert.match(api,/redis\.call\('LPUSH', KEYS\[2\], ARGV\[3\]\)/);
  assert.match(api,/frame_id_required/);
  assert.match(transport,/"frameId": str\(uuid\.uuid4\(\)\)/);
});

test('websocket tunnel has dedicated throughput and payload guards',()=>{
  assert.match(api,/AGENT_TUNNEL_RATE_LIMIT_PER_MINUTE=6000/);
  assert.match(api,/AGENT_RESPONSE_RATE_LIMIT_PER_MINUTE=1200/);
  assert.match(api,/WS_MAX_FRAME_BYTES=4\*1024\*1024/);
  assert.match(api,/WS_MAX_BASE64_BYTES/);
  assert.match(api,/workspace_ws_frame_invalid_base64/);
  assert.match(api,/workspace_ws_binary_metadata_required/);
  assert.match(api,/ws-frame',\{bodyLimit:MAX_AGENT_RELAY_BODY_BYTES,config:\{rateLimit:/);
  assert.match(api,/\/next',\{config:\{rateLimit:\{max:AGENT_TUNNEL_RATE_LIMIT_PER_MINUTE/);
});

test('browser delivery pump is serialized, bounded and close-aware',()=>{
  assert.match(api,/let pumpBusy=false/);
  assert.match(api,/if\(pumpBusy\|\|browserClosed\)return/);
  assert.match(api,/\.finally\(\(\)=>\{pumpBusy=false;\}\)/);
  assert.match(api,/let browserSendChain:Promise<void>=setup\.then\(\(\)=>undefined\)/);
  assert.match(api,/BrowserPendingBudget/);
  assert.match(api,/WS_BROWSER_BUFFERED_HIGH_WATER_BYTES/);
  assert.match(api,/WS_BROWSER_BACKPRESSURE_TIMEOUT_MS/);
  assert.match(api,/websocketDataToBuffer\(data\)/);
  assert.match(api,/browserSendChain\.then\(async\(\)=>\{/);
  assert.match(api,/kind:'ws_close'/);
  assert.match(api,/browserClosed=true;clearInterval\(pump\)/);
  assert.match(api,/workspace_gateway_browser_socket_error/);
});

test('redis relay queues are bounded by item count, bytes and ttl',()=>{
  assert.match(api,/ENQUEUE_BOUNDED_LIST_SCRIPT/);
  assert.match(api,/MACHINE_QUEUE_MAX_ITEMS=512/);
  assert.match(api,/WS_INPUT_MAX_ITEMS=512/);
  assert.match(api,/WS_MACHINE_QUEUE_MAX_BYTES/);
  assert.match(api,/WS_REDIS_INPUT_MAX_BYTES/);
  assert.match(api,/machineQueueBytesKey/);
  assert.match(api,/wsInputBytesKey/);
  assert.match(api,/accountDequeuedBytes/);
  assert.match(api,/workspace_gateway_backpressure/);
  assert.match(api,/workspace_ws_browser_backpressure/);
});

test('billing activation remains tied to a real upstream websocket frame',()=>{
  assert.match(api,/app\.post\('\/agent\/workspace-gateway\/ws-frame'/);
  assert.match(api,/activateGatewaySession\(db,binding\.sessionId,machineId\)/);
  assert.match(api,/A real upstream frame remains the billing activation signal/);
});

test('concurrent websocket activation accepts the transaction winner',()=>{
  assert.match(api,/if\(sessionUpdate\.count!==1\)\{/);
  assert.match(api,/status:WorkspaceSessionStatus\.RUNNING,booking:\{status:BookingStatus\.ACTIVE\}/);
  assert.match(api,/winner\?\{activated:false,expiresAt:winner\.expiresAt\}:null/);
});

test('session activation is cached away from repeated websocket frames',()=>{
  assert.match(api,/wsSessionActivatedKey=\(sessionId:string\)=>`workspace-gateway:ws-session-activated:\$\{sessionId\}`/);
  assert.match(api,/const activatedKey=wsSessionActivatedKey\(binding\.sessionId\)/);
  assert.match(api,/let ttl=await redis\.ttl\(activatedKey\)/);
  assert.match(api,/if\(ttl<1\)\{\s*const activation=await activateGatewaySession/);
  assert.match(api,/redis\.set\(activatedKey,'1','EX',ttl\)/);
  assert.match(api,/redis\.del\(wsSessionActivatedKey\(sessionId\)\)/);
  assert.match(api,/Channel readiness is intentionally separate from session activation/);
});

test('websocket subprotocol may cross the authenticated gateway',()=>{
  assert.match(api,/['"]sec-websocket-protocol['"]/);
});

test('agent developer runtime binds only to loopback and has no host bind mount',()=>{
  assert.match(agent,/127\.0\.0\.1::3000/);
  assert.match(agent,/--cap-drop=ALL/);
  assert.match(agent,/no-new-privileges/);
  assert.match(agent,/type=volume,source=/);
  assert.doesNotMatch(agent,/\/var\/run\/docker\.sock/);
  assert.doesNotMatch(agent,/type=bind/);
});

test('cleanup is fail closed and expired sessions are stopped',()=>{
  assert.match(api,/workspace_cleanup_unverified/);
  assert.match(api,/ModerationStatus\.QUARANTINED/);
  assert.match(agent,/self\._expired\(session\.get\("expiresAt"\)\)/);
});
