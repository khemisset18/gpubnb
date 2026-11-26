import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowsNativeGamepadBridge } from './windows-native-gamepad.js';

function controller({ axes = [0, 0, 0, 0], down = [], mapping = 'standard', connected = true } = {}) {
  return { connected, mapping, axes, buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: down.includes(i), value: down.includes(i) ? 1 : 0 })) };
}
function setup() {
  const events = [];
  const bridge = new WindowsNativeGamepadBridge({
    key: (code, up) => { events.push(['key', code, up]); return true; },
    pointerButton: (button, up) => { events.push(['button', button, up]); return true; },
    mouseRelative: (dx, dy) => { events.push(['mouse', dx, dy]); return true; },
  });
  return { bridge, events };
}

test('a standard gamepad maps movement, jump, fire and aiming to existing input', () => {
  const { bridge, events } = setup();
  assert.equal(bridge.update([controller({ axes: [0.9, -0.8, 0.7, -0.6], down: [0, 7] })]), true);
  assert.deepEqual(events, [
    ['key', 'Space', false], ['key', 'KeyW', false], ['key', 'KeyD', false],
    ['button', 0, false], ['mouse', 10, -8],
  ]);
  events.length = 0;
  bridge.update([controller({ down: [0, 7] })]);
  assert.deepEqual(events, [['key', 'KeyW', true], ['key', 'KeyD', true]], 'held buttons are not repeatedly injected');
  events.length = 0;
  bridge.update([controller()]);
  assert.deepEqual(events, [['key', 'Space', true], ['button', 0, true]]);
});

test('disconnection and unsupported mapping release every held input', () => {
  const { bridge, events } = setup();
  bridge.update([controller({ down: [4, 7, 12] })]);
  events.length = 0;
  assert.equal(bridge.update([controller({ mapping: 'nonstandard' })]), false);
  assert.deepEqual(events, [
    ['key', 'ShiftLeft', true], ['key', 'KeyW', true], ['button', 0, true],
  ]);
  events.length = 0;
  bridge.update([controller({ down: [7] })]);
  bridge.release();
  assert.deepEqual(events, [['button', 0, false], ['button', 0, true]]);
});

test('invalid and drifting analog input cannot create unbounded pointer events', () => {
  const { bridge, events } = setup();
  bridge.update([controller({ axes: [NaN, Infinity, 0.2, -0.3] })], 0);
  assert.deepEqual(events, []);
  bridge.update([controller({ axes: [0, 0, 200, -200] })], 20);
  assert.deepEqual(events, [['mouse', 14, -14]]);
});

test('unavailable input channel never marks a key as held', () => {
  let attempts = 0;
  const bridge = new WindowsNativeGamepadBridge({
    key: () => { attempts += 1; return false; }, pointerButton: () => false, mouseRelative: () => false,
  });
  bridge.update([controller({ down: [0] })]);
  bridge.update([controller({ down: [0] })]);
  assert.equal(attempts, 2);
  assert.equal(bridge.heldKeys.size, 0);
});

test('aim speed stays consistent on 60, 120, 144 and 240 Hz displays', () => {
  for (const hz of [60, 120, 144, 240]) {
    const {bridge, events} = setup();
    const pad = controller({axes: [0,0,1,0]});
    for (let frame=0; frame<hz; frame++) bridge.update([pad], frame*1000/hz);
    assert.equal(events.length,60, 'refresh rate '+hz);
    assert.ok(events.every(event => event[0]==='mouse' && event[1]===14 && event[2]===0));
  }
});

test('aim does not catch up after a long pause or a clock regression', () => {
  const {bridge, events} = setup();
  const pad=controller({axes:[0,0,1,0]});
  bridge.update([pad],0);
  bridge.update([pad],1);
  bridge.update([pad],60000);
  bridge.update([pad],60000);
  bridge.update([pad],100);
  bridge.update([pad],101);
  assert.deepEqual(events,[['mouse',14,0],['mouse',14,0]]);
  bridge.update([pad],120);
  assert.equal(events.length,3);
});

test('controller replacement releases previous keys before claiming new controls', () => {
  const {bridge,events}=setup();
  bridge.update([{...controller({down:[0,7]}),index:0,id:'first'}],0);
  events.length=0;
  bridge.update([{...controller({down:[4]}),index:1,id:'second'}],20);
  assert.deepEqual(events,[['key','Space',true],['button',0,true],['key','ShiftLeft',false]]);
});

test('key release is retried when the input channel rejects it', () => {
  let allowRelease=false;
  const events=[];
  const bridge=new WindowsNativeGamepadBridge({
    key:(code,up)=>{events.push([code,up]);return !up||allowRelease;},
    pointerButton:()=>true,mouseRelative:()=>true,
  });
  bridge.update([controller({down:[0]})],0);
  bridge.update([controller()],10);
  assert.equal(bridge.heldKeys.has('Space'),true);
  allowRelease=true;
  bridge.update([controller()],20);
  assert.equal(bridge.heldKeys.size,0);
  assert.deepEqual(events,[['Space',false],['Space',true],['Space',true]]);
});
