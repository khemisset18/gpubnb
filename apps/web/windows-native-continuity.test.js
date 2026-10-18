import assert from 'node:assert/strict';
import test from 'node:test';
import { Stage4VideoContinuity } from './windows-native-continuity.js';
const frame = (n, epoch=1n) => ({state:'ready', streamEpoch:epoch, frameSequence:BigInt(n), renderedFrames:n});
const almostComplete = () => {
  const p=new Stage4VideoContinuity();
  for(let s=0;s<=299;s++)p.observe(frame(s+1),s*1000);
  return p;
};
test('UI timer cannot manufacture the final second without a decoded frame',()=>{
  const p=almostComplete();
  assert.equal(p.snapshot(300000).video300sObserved,false);
  assert.equal(p.snapshot(301999).continuousSeconds,299);
  assert.equal(p.observe(frame(301),300000).video300sObserved,true);
});
test('disconnect after 300 seconds resets current continuity instead of latching a stale PASS',()=>{
  const p=almostComplete();p.observe(frame(301),300000);p.reset();
  assert.equal(p.snapshot(300001).video300sObserved,false);
  assert.equal(p.snapshot(300001).continuousSeconds,0);
});
for(const reason of ['gap','epoch','replay','clock','not-decoded'])test(`failure after success invalidates continuity: ${reason}`,()=>{
  const p=almostComplete();p.observe(frame(301),300000);
  if(reason==='gap')p.snapshot(304000);
  if(reason==='epoch')p.observe(frame(302,2n),301000);
  if(reason==='replay')p.observe(frame(301),301000);
  if(reason==='clock')p.observe(frame(302),299999);
  if(reason==='not-decoded')p.observe({...frame(302),state:'connected'},301000);
  assert.equal(p.snapshot(reason==='clock'?299999:304000).video300sObserved,false);
});
