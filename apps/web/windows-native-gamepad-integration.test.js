import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowsNativeDesktopClient } from './windows-native-desktop.js';

function emitter(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    emit(name, event = {}) { listeners.get(name)?.(event); },
  };
}

test('gamepad sends only while remote canvas is focused, releases on blur/hidden tab', () => {
  const originals = ['navigator', 'requestAnimationFrame', 'cancelAnimationFrame'].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const scheduled = new Map();
  let nextId = 1;
  const pad = { connected: true, mapping: 'standard', axes: [0, -1, 0.7, 0],
    buttons: Array.from({length: 16}, (_, i) => ({pressed: i === 0 || i === 7})) };
  const events = [];
  let unbind;
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [pad] } });
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true,
      value: (callback) => { const id = nextId++; scheduled.set(id, callback); return id; } });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true,
      value: (id) => scheduled.delete(id) });
    const canvas = emitter({getBoundingClientRect: () => ({left:0,top:0,width:100,height:100}),
      getContext: () => ({drawImage() {}, clearRect() {}}), setAttribute() {}});
    const keyboard = emitter({hidden: false});
    const client = new WindowsNativeDesktopClient({canvas,
      mediaFactory: () => ({push() {}, close() {}})});
    client.key = (code, up) => { events.push(['key', code, up]); return true; };
    client.pointerButton = (button, up) => { events.push(['button', button, up]); return true; };
    client.mouseRelative = (dx, dy) => { events.push(['mouse', dx, dy]); return true; };
    unbind = client.bindDom({keyboardTarget: keyboard, pointerTarget: canvas});
    assert.equal(scheduled.size, 0, 'unfocused canvas never polls a controller');
    canvas.emit('focus');
    assert.equal(scheduled.size, 1);
    const tick = () => { const [id, fn] = scheduled.entries().next().value; scheduled.delete(id); fn(); };
    tick();
    assert.deepEqual(events, [['key','Space',false],['key','KeyW',false],['button',0,false],['mouse',10,0]]);
    events.length = 0;
    keyboard.emit('focusin', {target: {}});
    assert.deepEqual(events, [['key','Space',true],['key','KeyW',true],['button',0,true]]);
    assert.equal(scheduled.size, 0, 'losing focus cancels polling');
    events.length = 0;
    canvas.emit('focus');
    tick();
    keyboard.hidden = true;
    keyboard.emit('visibilitychange');
    assert.deepEqual(events.slice(-3), [['key','Space',true],['key','KeyW',true],['button',0,true]]);
    assert.equal(scheduled.size, 0);
  } finally {
    unbind?.();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
