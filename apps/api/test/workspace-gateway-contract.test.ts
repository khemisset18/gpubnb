import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api=fs.readFileSync(new URL('../src/workspace-gateway.ts',import.meta.url),'utf8');
const agent=fs.readFileSync(new URL('../../../agent/gpubnb_agent/workspace_gateway.py',import.meta.url),'utf8');

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

test('websocket tunnel has dedicated throughput and payload guards',()=>{
  assert.match(api,/AGENT_TUNNEL_RATE_LIMIT_PER_MINUTE=6000/);
  assert.match(api,/AGENT_RESPONSE_RATE_LIMIT_PER_MINUTE=1200/);
  assert.match(api,/WS_MAX_FRAME_BYTES=4\*1024\*1024/);
  assert.match(api,/WS_MAX_BASE64_BYTES/);
  assert.match(api,/workspace_ws_frame_too_large/);
  assert.match(api,/ws-frame',\{bodyLimit:MAX_AGENT_RELAY_BODY_BYTES,config:\{rateLimit:/);
  assert.match(api,/\/next',\{config:\{rateLimit:\{max:AGENT_TUNNEL_RATE_LIMIT_PER_MINUTE/);
});

test('browser delivery pump is serialized and close-aware',()=>{
  assert.match(api,/let pumpBusy=false/);
  assert.match(api,/if\(pumpBusy\|\|browserClosed\)return/);
  assert.match(api,/\.finally\(\(\)=>\{pumpBusy=false;\}\)/);
  assert.match(api,/let browserSendChain:Promise<unknown>=setup/);
  assert.match(api,/browserClosed=true;clearInterval\(pump\)/);
  assert.match(api,/workspace_gateway_browser_socket_error/);
});

test('billing activation remains tied to a real upstream websocket frame',()=>{
  assert.match(api,/app\.post\('\/agent\/workspace-gateway\/ws-frame'/);
  assert.match(api,/activateGatewaySession\(db,binding\.sessionId,machineId\)/);
  assert.match(api,/A real frame remains the billing activation signal/);
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