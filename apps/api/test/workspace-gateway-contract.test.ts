import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api=fs.readFileSync(new URL('../src/workspace-gateway.ts',import.meta.url),'utf8');
const agent=fs.readFileSync(new URL('../../../agent/gpubnb_agent/workspace_gateway.py',import.meta.url),'utf8');
const transport=fs.readFileSync(new URL('../../../agent/gpubnb_agent/workspace_gateway_v2.py',import.meta.url),'utf8');
const protocol=fs.readFileSync(new URL('../../../agent/gpubnb_agent/workspace_gateway_v6.py',import.meta.url),'utf8');

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
  assert.match(api,/502:'Bad Gateway'/);
  assert.match(api,/503:'Service Unavailable'/);
  assert.match(api,/504:'Gateway Timeout'/);
  assert.doesNotMatch(api,/if\(!token\)\{socket\.destroy\(\)/);
});

test('gateway protocol v2 is explicitly negotiated on the signed register route',()=>{
  assert.match(api,/const GATEWAY_PROTOCOL_VERSION=2/);
  assert.match(api,/gatewayProtocolVersion\?:number/);
  assert.match(api,/body\.gatewayProtocolVersion===undefined\?1:Number\(body\.gatewayProtocolVersion\)/);
  assert.match(api,/invalid_gateway_protocol_version/);
  assert.match(api,/connectionMetadata:\{gatewayPath:`\/workspace-gateway\/\$\{sessionId\}`,runtimeId:String\(body\.runtimeId\),localPort:Number\(body\.localPort\),gatewayProtocolVersion\}/);
  assert.match(protocol,/GATEWAY_PROTOCOL_VERSION = 2/);
  assert.match(protocol,/gatewayProtocolVersion/);
  assert.match(protocol,/with_gateway_protocol_capability/);
  assert.match(protocol,/method\.upper\(\) == "POST"/);
  assert.match(protocol,/parts\[4\] == "register"/);
});

test('protocol v2 opens the real upstream before exposing the browser websocket',()=>{
  const branch=api.indexOf('if(preflightUpstream){');
  assert.ok(branch>=0,'protocol-v2 preflight branch must exist');
  const wait=api.indexOf('await waitForUpstream(false)',branch);
  const browserUpgrade=api.indexOf('wss.handleUpgrade(request,socket as Socket,head',branch);
  assert.ok(wait>branch,'upstream ACK wait must be inside the preflight branch');
  assert.ok(browserUpgrade>wait,'browser upgrade must happen only after the upstream ACK wait');
  assert.match(api,/workspace_gateway_upstream_preflight_started/);
  assert.match(api,/workspace_gateway_upstream_preflight_ready/);
  assert.match(api,/workspace_gateway_upstream_preflight_failed/);
  assert.match(api,/rejectWebSocketUpgrade\(socket as Socket,status,'workspace_upstream_not_ready'\)/);
});

test('browser websocket consumes an explicit signed agent open acknowledgement',()=>{
  assert.match(api,/WS_UPSTREAM_OPEN_TIMEOUT_MS/);
  assert.match(api,/openRequestId=crypto\.randomUUID\(\)/);
  assert.match(api,/waitJson\(redis,responseKey\(openRequestId\),WS_UPSTREAM_OPEN_TIMEOUT_MS\)/);
  assert.match(api,/opened\.status!==101/);
  assert.match(api,/workspace_gateway_upstream_opened/);
  assert.match(transport,/request_id = str\(item\.get\("id"\) or ""\)/);
  assert.match(transport,/"status": 101/);
  assert.match(transport,/"status": 502/);
  assert.match(transport,/"\/agent\/workspace-gateway\/respond"/);
  assert.match(transport,/workspace_trace:|workspace_trace:\{event\}/);
  assert.match(transport,/"ws_open_ack"/);
  assert.doesNotMatch(api,/WS_UPSTREAM_FIRST_FRAME_TIMEOUT_MS/);
});

test('legacy agents retain first-upstream-frame readiness during rollout',()=>{
  assert.match(api,/const gatewayProtocolVersion=Number\(metadata\.gatewayProtocolVersion\|\|1\)/);
  assert.match(api,/const preflightUpstream=gatewayProtocolVersion>=2/);
  assert.match(api,/workspace_gateway_legacy_upstream_ready/);
  assert.match(api,/const legacyReady=await redis\.get\(wsUpstreamReadyKey\(channelId\)\)/);
  assert.match(api,/binding\.activationMode!=='browser-delivery'/);
  assert.match(api,/activateGatewaySession\(db,binding\.sessionId,machineId\)/);
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
  assert.match(transport,/"ws_open_received"/);
  assert.match(transport,/"ws_local_connected"/);
  assert.match(transport,/"ws_first_local_frame"/);
  assert.match(transport,/"ws_first_upstream_batch"/);
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
  assert.match(api,/workspace_gateway_browser_delivery_failed/);
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

test('protocol v2 billing starts only after an upstream frame is delivered to the authenticated browser',()=>{
  assert.match(api,/activationMode:GatewayActivationMode=preflightUpstream\?'browser-delivery':'upstream-frame'/);
  assert.match(api,/binding\.activationMode!=='browser-delivery'/);
  assert.match(api,/const ensureBrowserDeliveryActivation=\(\)=>\{/);
  assert.match(api,/ws\.send\(payload,\{binary:parsed\.binary\},error=>\{/);
  assert.match(api,/void ensureBrowserDeliveryActivation\(\)/);
  assert.match(api,/workspace_gateway_browser_delivery_activated/);
  const delivery=api.indexOf('ws.send(payload,{binary:parsed.binary},error=>{');
  const activation=api.indexOf('void ensureBrowserDeliveryActivation()',delivery);
  assert.ok(delivery>=0&&activation>delivery,'billing activation must follow successful browser delivery callback');
});

test('concurrent websocket activation accepts the transaction winner',()=>{
  assert.match(api,/if\(sessionUpdate\.count!==1\)\{/);
  // The loser's re-check must key off workspaceActivatedAt (the true idempotency marker),
  // not booking.status:ACTIVE alone - a booking can already be ACTIVE via the
  // GPU_DIAGNOSTIC beta-bypass path before any interactive workspace ever activates.
  assert.match(api,/status:WorkspaceSessionStatus\.RUNNING,booking:\{workspaceActivatedAt:\{not:null\}\}/);
  assert.match(api,/winner\?\{activated:false,expiresAt:winner\.expiresAt\}:null/);
});

test('session activation remains cached and cleanup removes the activation marker',()=>{
  assert.match(api,/wsSessionActivatedKey=\(sessionId:string\)=>`workspace-gateway:ws-session-activated:\$\{sessionId\}`/);
  assert.match(api,/const activatedKey=wsSessionActivatedKey\(sessionId\)/);
  assert.match(api,/let ttl=await redis\.ttl\(activatedKey\)/);
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
  // moderationStatus now flows through the shared enterQuarantine() helper (which also
  // appends a durable MachineQuarantineEvent history row) rather than a bare literal
  // column write - see quarantine-service.ts.
  assert.match(api,/enterQuarantine\(tx,\{machineId,reasonCode:'WORKSPACE_CLEANUP_FAILED'/);
  assert.match(agent,/self\._expired\(session\.get\("expiresAt"\)\)/);
});
