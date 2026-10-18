import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayChannelLeaseGuard } from '../src/workspace-gateway-channel-lease.js';

function fixture() {
  const state = { time: 10000, browser: JSON.stringify({sessionId:'s1',userId:'u1'}) as string|null,
    workspace: {renterId:'u1', expiresAt:new Date(500000)} as {renterId:string;expiresAt:Date}|null,
    fail: false, reads: 0 };
  const authorized = createGatewayChannelLeaseGuard({sessionId:'s1',userId:'u1',now:()=>state.time,
    readBrowser:async()=>{state.reads++;if(state.fail)throw Error('network');return state.browser;},
    readWorkspace:async()=>state.workspace});
  return {state, authorized};
}
test('live gateway identity and current renter workspace authorize with bounded cache',async()=>{
  const {state,authorized}=fixture();assert.equal(await authorized(),true);
  state.time+=500;assert.equal(await authorized(),true);assert.equal(state.reads,1);
  state.time+=1000;assert.equal(await authorized(),true);assert.equal(state.reads,2);
});
for(const reason of ['expired-cookie','malformed-cookie','different-session','different-user','workspace-ended','workspace-reassigned','expiry','network']){
  test(`open native stream loses authorization on ${reason}`,async()=>{
    const {state,authorized}=fixture();assert.equal(await authorized(),true);state.time+=1001;
    if(reason==='expired-cookie')state.browser=null;
    if(reason==='malformed-cookie')state.browser='{bad';
    if(reason==='different-session')state.browser=JSON.stringify({sessionId:'other',userId:'u1'});
    if(reason==='different-user')state.browser=JSON.stringify({sessionId:'s1',userId:'other'});
    if(reason==='workspace-ended')state.workspace=null;
    if(reason==='workspace-reassigned')state.workspace!.renterId='other';
    if(reason==='expiry')state.workspace!.expiresAt=new Date(state.time);
    if(reason==='network')state.fail=true;
    assert.equal(await authorized(),false);
  });
}
test('workspace expiry cannot be extended by cached successful authorization',async()=>{
  const {state,authorized}=fixture();state.workspace!.expiresAt=new Date(state.time+10);
  assert.equal(await authorized(),true);state.time+=10;assert.equal(await authorized(),false);
});
test('clock reversal cannot reuse a cached grant',async()=>{
  const {state,authorized}=fixture();assert.equal(await authorized(),true);state.time--;state.browser=null;
  assert.equal(await authorized(),false);
});
test('unresponsive authorization dependencies fail closed with a bounded deadline',async()=>{
  const authorized=createGatewayChannelLeaseGuard({sessionId:'s1',userId:'u1',timeoutMs:15,
    readBrowser:()=>new Promise(()=>{}),readWorkspace:()=>new Promise(()=>{})});
  assert.equal(await authorized(),false);
});
