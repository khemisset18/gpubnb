import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WindowsNativeDesktopClient,
  sameOriginWebSocketUrl,
} from './windows-native-desktop.js';

class FakeSocket {
  constructor() {
    this.binaryType = '';
    this.readyState = 0;
    this.sent = [];
    this.closed = [];
    this.listeners = new Map();
  }

  addEventListener(name, callback) {
    const list = this.listeners.get(name) ?? [];
    list.push(callback);
    this.listeners.set(name, list);
  }

  emit(name, event = {}) {
    for (const callback of this.listeners.get(name) ?? []) callback(event);
  }

  send(value) {
    this.sent.push(value);
  }

  close(code, reason) {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
}

function fakeCanvas() {
  const listeners = new Map();
  const draws = [];
  const attributes = new Map();
  return {
    width: 0,
    height: 0,
    draws,
    attributes,
    focused: 0,
    getContext() {
      return {
        drawImage(frame, x, y, width, height) {
          draws.push({ frame, x, y, width, height });
        },
      };
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 200, height: 100 };
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    focus() {
      this.focused += 1;
    },
    addEventListener(name, callback) {
      const list = listeners.get(name) ?? [];
      list.push(callback);
      listeners.set(name, list);
    },
    removeEventListener(name, callback) {
      const list = listeners.get(name) ?? [];
      listeners.set(name, list.filter((candidate) => candidate !== callback));
    },
    emit(name, event) {
      for (const callback of listeners.get(name) ?? []) callback(event);
    },
  };
}

test('gateway websocket URL is same-origin, credential-free and never downgrades HTTPS', () => {
  assert.equal(
    sameOriginWebSocketUrl('/native/session/abc', 'https://example.test/bookings.html'),
    'wss://example.test/native/session/abc',
  );
  assert.equal(
    sameOriginWebSocketUrl('wss://example.test/native/session/abc', 'https://example.test/'),
    'wss://example.test/native/session/abc',
  );
  assert.equal(
    sameOriginWebSocketUrl('/native/session/abc', 'http://127.0.0.1:3000/page'),
    'ws://127.0.0.1:3000/native/session/abc',
  );

  for (const value of [
    'wss://other.test/native/session/abc',
    'ws://example.test/native/session/abc',
    'https://example.test/native/session/abc',
    'wss://user:secret@example.test/native/session/abc',
    'wss://example.test/native/session/abc?token=secret',
    'wss://example.test/native/session/abc#secret',
    ' wss://example.test/native/session/abc',
  ]) {
    assert.throws(
      () => sameOriginWebSocketUrl(value, 'https://example.test/page'),
      /windows_native_gateway_/,
      value,
    );
  }
});

test('input is impossible until a real decoded frame is rendered and then stays epoch-fenced', async () => {
  const socket = new FakeSocket();
  const canvas = fakeCanvas();
  const states = [];
  const errors = [];
  const inputCalls = [];
  let mediaOptions;

  const client = new WindowsNativeDesktopClient({
    canvas,
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
    webSocketFactory: () => socket,
    mediaFactory: (options) => {
      mediaOptions = options;
      return {
        async push() {
          const frame = {
            displayWidth: 1920,
            displayHeight: 1080,
            timestamp: 1,
            closed: false,
            close() { this.closed = true; },
          };
          options.output(frame, {
            streamEpoch: 41n,
            frameSequence: 7n,
            width: 1920,
            height: 1080,
            keyframe: true,
            codec: 'avc1.640028',
          });
          return true;
        },
        close() {},
      };
    },
    inputFactory: ({ streamEpoch, send }) => {
      assert.equal(streamEpoch, 41n);
      return {
        key(code, keyUp) {
          inputCalls.push({ kind: 'key', code, keyUp });
          send(Uint8Array.from([1, 2, 3]));
          return true;
        },
        mouseAbsolute(x, y, width, height) {
          inputCalls.push({ kind: 'absolute', x, y, width, height });
          send(Uint8Array.from([4]));
          return true;
        },
        mouseButton(button, keyUp) {
          inputCalls.push({ kind: 'button', button, keyUp });
          send(Uint8Array.from([5]));
          return true;
        },
        mouseWheel(delta) {
          inputCalls.push({ kind: 'wheel', delta });
          send(Uint8Array.from([6]));
          return true;
        },
      };
    },
  });

  client.start('/native/session/abc', 'https://example.test/page');
  assert.equal(socket.binaryType, 'arraybuffer');
  assert.equal(client.key('KeyA'), false, 'no media proof means no input');
  assert.equal(client.pointerButton(0), false);

  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: new ArrayBuffer(3) });
  await client.mediaQueue;

  assert.equal(errors.length, 0);
  assert.equal(canvas.draws.length, 1);
  assert.equal(client.key('KeyA'), true);
  assert.equal(client.pointerAbsolute(110, 70), true);
  assert.equal(client.pointerButton(0), true);
  assert.equal(client.wheel(120), true);
  assert.equal(socket.sent.length, 4);
  assert.ok(socket.sent.every((item) => item instanceof Uint8Array));
  assert.deepEqual(
    inputCalls.map((item) => item.kind),
    ['key', 'absolute', 'button', 'wheel'],
  );
  assert.equal(inputCalls[1].x, 100);
  assert.equal(inputCalls[1].y, 50);
  assert.equal(inputCalls[3].delta, -120);
  assert.ok(states.some((item) => item.state === 'ready' && item.streamEpoch === 41n));
  assert.equal(typeof mediaOptions.output, 'function');
});

test('text websocket messages fail closed and close the native desktop client', async () => {
  const socket = new FakeSocket();
  const errors = [];
  let mediaClosed = 0;
  const client = new WindowsNativeDesktopClient({
    canvas: fakeCanvas(),
    onError: (error) => errors.push(error),
    webSocketFactory: () => socket,
    mediaFactory: () => ({
      async push() { throw new Error('must_not_decode_text'); },
      close() { mediaClosed += 1; },
    }),
  });

  client.start('/native/session/abc', 'https://example.test/page');
  socket.readyState = 1;
  socket.emit('message', { data: 'not-binary' });
  await Promise.resolve();

  assert.match(errors[0].message, /windows_native_media_binary_required/);
  assert.equal(mediaClosed, 1);
  assert.equal(socket.closed.length, 1);
});

test('socket close releases held key and button before authority disappears', async () => {
  const socket = new FakeSocket();
  const calls = [];
  const client = new WindowsNativeDesktopClient({
    canvas: fakeCanvas(),
    webSocketFactory: () => socket,
    mediaFactory: ({ output }) => ({
      async push() {
        output(
          { displayWidth: 1920, displayHeight: 1080, close() {} },
          { streamEpoch: 5n, frameSequence: 1n, width: 1920, height: 1080, keyframe: true, codec: 'avc1.640028' },
        );
        return true;
      },
      close() {},
    }),
    inputFactory: ({ send }) => ({
      key(code, keyUp) {
        calls.push(['key', code, keyUp]);
        send(Uint8Array.of(1));
        return true;
      },
      mouseAbsolute() { return true; },
      mouseButton(button, keyUp) {
        calls.push(['button', button, keyUp]);
        send(Uint8Array.of(2));
        return true;
      },
      mouseWheel() { return true; },
    }),
  });

  client.start('/native/session/abc', 'https://example.test/page');
  socket.readyState = 1;
  socket.emit('message', { data: new ArrayBuffer(1) });
  await client.mediaQueue;
  client.key('ShiftLeft');
  client.pointerButton(0);
  socket.emit('close');

  assert.deepEqual(calls, [
    ['key', 'ShiftLeft', false],
    ['button', 0, false],
    ['key', 'ShiftLeft', true],
    ['button', 0, true],
  ]);
});

test('DOM binding blocks browser handling only for events accepted by the native protocol', async () => {
  const socket = new FakeSocket();
  const canvas = fakeCanvas();
  const keyboard = {
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name, callback) {
      if (this.listeners.get(name) === callback) this.listeners.delete(name);
    },
  };
  const accepted = [];
  const client = new WindowsNativeDesktopClient({
    canvas,
    webSocketFactory: () => socket,
    mediaFactory: ({ output }) => ({
      async push() {
        output(
          { displayWidth: 1920, displayHeight: 1080, close() {} },
          { streamEpoch: 3n, frameSequence: 1n, width: 1920, height: 1080, keyframe: true, codec: 'avc1.640028' },
        );
        return true;
      },
      close() {},
    }),
    inputFactory: () => ({
      key(code) { accepted.push(code); return code === 'KeyA'; },
      mouseAbsolute() { return false; },
      mouseButton() { return false; },
      mouseWheel() { return false; },
    }),
  });

  client.start('/native/session/abc', 'https://example.test/page');
  socket.readyState = 1;
  socket.emit('message', { data: new ArrayBuffer(1) });
  await client.mediaQueue;

  const unbind = client.bindDom({ keyboardTarget: keyboard, pointerTarget: canvas });
  let prevented = 0;
  keyboard.listeners.get('keydown')({
    code: 'KeyA',
    preventDefault() { prevented += 1; },
  });
  keyboard.listeners.get('keydown')({
    code: 'Unidentified',
    preventDefault() { prevented += 1; },
  });

  assert.deepEqual(accepted, ['KeyA', 'Unidentified']);
  assert.equal(prevented, 1);
  assert.equal(canvas.attributes.get('tabindex'), '0');
  unbind();
});


test('new stream epoch releases held input through the old fence before switching', async () => {
  const socket = new FakeSocket();
  const calls = [];
  let output;
  let epoch = 10n;
  const client = new WindowsNativeDesktopClient({
    canvas: fakeCanvas(),
    webSocketFactory: () => socket,
    mediaFactory: (options) => {
      output = options.output;
      return {
        async push() {
          output(
            { displayWidth: 1920, displayHeight: 1080, close() {} },
            { streamEpoch: epoch, frameSequence: 1n, width: 1920, height: 1080, keyframe: true, codec: 'avc1.640028' },
          );
          return true;
        },
        close() {},
      };
    },
    inputFactory: ({ streamEpoch, send }) => ({
      key(code, keyUp) {
        calls.push([streamEpoch, 'key', code, keyUp]);
        send(Uint8Array.of(1));
        return true;
      },
      mouseAbsolute() { return true; },
      mouseButton(button, keyUp) {
        calls.push([streamEpoch, 'button', button, keyUp]);
        send(Uint8Array.of(2));
        return true;
      },
      mouseWheel() { return true; },
    }),
  });

  client.start('/native/session/abc', 'https://example.test/page');
  socket.readyState = 1;
  socket.emit('message', { data: new ArrayBuffer(1) });
  await client.mediaQueue;
  client.key('ControlLeft');
  client.pointerButton(0);

  epoch = 11n;
  socket.emit('message', { data: new ArrayBuffer(1) });
  await client.mediaQueue;

  assert.deepEqual(calls, [
    [10n, 'key', 'ControlLeft', false],
    [10n, 'button', 0, false],
    [10n, 'key', 'ControlLeft', true],
    [10n, 'button', 0, true],
  ]);
});
