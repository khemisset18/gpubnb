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

test('browser websocket closes fail-closed when no signed upstream frame arrives',()=>{
  assert.match(api,/WS_UPSTREAM_FIRST_FRAME_TIMEOUT_MS/);
  assert.match(api,/workspace-gateway:ws-upstream-ready:/);
  assert.match(api,/workspace_gateway_upstream_timeout/);
  assert.match(api,/workspace upstream unavailable/);
  assert.match(api,/redis\.set\(wsUpstreamReadyKey\(channelId\),'1'/);
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
