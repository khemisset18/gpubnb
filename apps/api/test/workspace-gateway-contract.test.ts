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
