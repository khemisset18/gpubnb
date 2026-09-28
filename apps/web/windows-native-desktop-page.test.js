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
