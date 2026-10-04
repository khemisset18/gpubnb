import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountWindowsNativeDesktop,
  nativeDesktopStreamPath,
} from './windows-native-desktop-page.js';

test('native desktop stream path contains only the public session identifier', () => {
  assert.equal(
    nativeDesktopStreamPath('sess-ABC_123'),
    '/workspace-gateway/sess-ABC_123/native-stream',
  );
  for (const value of ['', '../other', 'a?token=secret', 'a/b', 'é', 'x'.repeat(201)]) {
    assert.throws(() => nativeDesktopStreamPath(value), /windows_native_session_id_invalid/);
  }
});

test('page mounts the client without exposing a capability in URL or DOM', () => {
  const canvas = {};
  const status = { textContent: '' };
  const closeListeners = [];
  const closeButton = {
    addEventListener(name, callback) {
      if (name === 'click') closeListeners.push(callback);
    },
  };
  const documentObject = {
    querySelector(selector) {
      return {
        '#nativeDesktopCanvas': canvas,
        '#nativeDesktopStatus': status,
        '#nativeDesktopClose': closeButton,
      }[selector] ?? null;
    },
  };
  const calls = [];
  let unbound = 0;
  let closed = 0;
  const client = {
    bindDom(options) {
      calls.push(['bind', options]);
      return () => { unbound += 1; };
    },
    start(path, base) {
      calls.push(['start', path, base]);
    },
    close() {
      closed += 1;
    },
  };

  const mounted = mountWindowsNativeDesktop({
    documentObject,
    locationObject: {
      href: 'https://example.test/windows-native-desktop.html?session=sess-1',
      search: '?session=sess-1',
    },
    clientFactory(options) {
      assert.equal(options.canvas, canvas);
      assert.equal(typeof options.onState, 'function');
      assert.equal(typeof options.onError, 'function');
      return client;
    },
  });

  assert.equal(mounted.streamPath, '/workspace-gateway/sess-1/native-stream');
  assert.deepEqual(calls[1], [
    'start',
    '/workspace-gateway/sess-1/native-stream',
    'https://example.test/windows-native-desktop.html?session=sess-1',
  ]);
  assert.ok(!JSON.stringify(calls).includes('token'));
  closeListeners[0]();
  assert.equal(unbound, 1);
  assert.equal(closed, 1);
});


test('unexpected transport close reconnects with a fresh client', () => {
  const canvas = {};
  const status = { textContent: '' };
  const closeButton = { addEventListener() {} };
  const documentObject = {
    querySelector(selector) {
      return {
        '#nativeDesktopCanvas': canvas,
        '#nativeDesktopStatus': status,
        '#nativeDesktopClose': closeButton,
      }[selector] ?? null;
    },
  };
  const clients = [];
  const timers = [];
  const clientFactory = (options) => {
    const record = {
      options,
      starts: [],
      closed: 0,
      unbound: 0,
    };
    const client = {
      bindDom() {
        return () => { record.unbound += 1; };
      },
      start(path, base) {
        record.starts.push([path, base]);
      },
      close() {
        record.closed += 1;
      },
    };
    record.client = client;
    clients.push(record);
    return client;
  };

  mountWindowsNativeDesktop({
    documentObject,
    locationObject: {
      href: 'https://example.test/windows-native-desktop.html?session=sess-1',
      search: '?session=sess-1',
    },
    clientFactory,
    setTimeoutFn(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeoutFn() {},
    now: () => 1000,
  });

  assert.equal(clients.length, 1);
  clients[0].options.onState({ state: 'closed' });

  assert.equal(clients[0].unbound, 1);
  assert.equal(status.textContent, 'Connexion interrompue, reconnexion…');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 250);

  timers[0].callback();

  assert.equal(clients.length, 2);
  assert.notEqual(clients[0].client, clients[1].client);
  assert.deepEqual(clients[1].starts[0], [
    '/workspace-gateway/sess-1/native-stream',
    'https://example.test/windows-native-desktop.html?session=sess-1',
  ]);
});

test('pagehide closes transport and pageshow recreates it without reviving after explicit close', () => {
  const canvas = {};
  const status = { textContent: '' };
  const closeListeners = [];
  const closeButton = {
    addEventListener(name, callback) {
      if (name === 'click') closeListeners.push(callback);
    },
  };
  const documentObject = {
    querySelector(selector) {
      return {
        '#nativeDesktopCanvas': canvas,
        '#nativeDesktopStatus': status,
        '#nativeDesktopClose': closeButton,
      }[selector] ?? null;
    },
  };
  const listeners = new Map();
  const windowObject = {
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener(name, callback) {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
    emit(name, event = {}) {
      listeners.get(name)?.(event);
    },
  };
  const clients = [];
  const clientFactory = (options) => {
    const record = {
      options,
      closed: 0,
      unbound: 0,
    };
    const client = {
      bindDom() {
        return () => { record.unbound += 1; };
      },
      start() {},
      close() {
        record.closed += 1;
      },
    };
    record.client = client;
    clients.push(record);
    return client;
  };

  mountWindowsNativeDesktop({
    documentObject,
    locationObject: {
      href: 'https://example.test/windows-native-desktop.html?session=sess-1',
      search: '?session=sess-1',
    },
    windowObject,
    clientFactory,
  });

  assert.equal(clients.length, 1);

  windowObject.emit('pagehide', { persisted: true });
  assert.equal(clients[0].unbound, 1);
  assert.equal(clients[0].closed, 1);

  windowObject.emit('pageshow', { persisted: true });
  assert.equal(clients.length, 2, 'bfcache/page restore gets a fresh client');

  closeListeners[0]();
  assert.equal(clients[1].closed, 1);
  assert.equal(status.textContent, 'Session vidéo fermée');

  windowObject.emit('pageshow', { persisted: true });
  assert.equal(clients.length, 2, 'explicit close must never reconnect');
});
