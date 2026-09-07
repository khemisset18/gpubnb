import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const gatewayUrl=new URL('../src/workspace-gateway.ts',import.meta.url);
const renterUrl=new URL('../src/workspace-renter-routes.ts',import.meta.url);
const accessUrl=new URL('../src/workspace-access.ts',import.meta.url);

test('renter workspace access propagates the Fastify request id into the one-time grant',async()=>{
  const renter=await readFile(renterUrl,'utf8');
  const access=await readFile(accessUrl,'utf8');
  assert.match(renter,/issueWorkspaceAccessGrant\(redis, \{ userId: session\.userId, bookingId, sessionId: row\.id, requestId: request\.id \}\)/);
  assert.match(access,/requestId\?:string/);
});

test('gateway critical websocket logs share one complete correlation context',async()=>{
  const gateway=await readFile(gatewayUrl,'utf8');
  assert.match(gateway,/jobId:true/);
  assert.match(gateway,/accessRequestId:consumed\.requestId/);
  assert.match(gateway,/accessRequestId\?:string/);
  assert.match(gateway,/const gatewayLog=app\.log\.child\(\{accessRequestId:browser\.accessRequestId,bookingId:row\.bookingId,jobId:row\.jobId,workspaceSessionId:sessionId,machineId:row\.machineId,channelId,channel:channelLogId,openRequestId\}\)/);
  for(const event of [
    'workspace_gateway_browser_connected',
    'workspace_gateway_upstream_opened',
    'workspace_gateway_upstream_open_failed',
    'workspace_gateway_browser_backpressure_timeout',
    'workspace_gateway_pump_failed',
    'workspace_gateway_send_failed',
    'workspace_gateway_browser_closed',
  ]){
    assert.match(gateway,new RegExp(`gatewayLog\\.(?:info|warn|error)\\(\\{[^}]*event:'${event}'`),`${event} must use correlated gatewayLog`);
  }
});

test('workspace correlation never adds bearer secrets or payload data to the child logger',async()=>{
  const gateway=await readFile(gatewayUrl,'utf8');
  const marker='const gatewayLog=app.log.child(';
  const start=gateway.indexOf(marker);
  assert.ok(start>=0);
  const end=gateway.indexOf(');',start);
  const child=gateway.slice(start,end+2);
  for(const forbidden of ['token','cookie','grant','signature','dataBase64','rawBody','headers']){
    assert.doesNotMatch(child,new RegExp(`\\b${forbidden}\\b`,'i'),`${forbidden} must not be part of the correlation logger`);
  }
});
