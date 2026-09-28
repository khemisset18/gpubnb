'use strict';

import {
  CanvasVideoFrameRenderer,
  WindowsNativeWebCodecsSession,
} from './windows-native-media.js';
import {
  WindowsNativeInputEncoder,
} from './windows-native-input.js';

function fail(code) {
  throw new Error(code);
}

export function sameOriginWebSocketUrl(value, base = globalThis.location?.href) {
  if (typeof value !== 'string' || !value || typeof base !== 'string' || !base) {
    fail('windows_native_gateway_url_invalid');
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('windows_native_gateway_url_invalid');
  }

  const baseUrl = new URL(base);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    fail('windows_native_gateway_base_invalid');
  }

  const explicitScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
  const url = new URL(value, baseUrl);
  if (!explicitScheme) {
    url.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  }
  if (!['ws:', 'wss:'].includes(url.protocol)) fail('windows_native_gateway_scheme');
  if (url.host !== baseUrl.host) fail('windows_native_gateway_cross_origin');
  if (baseUrl.protocol === 'https:' && url.protocol !== 'wss:') {
    fail('windows_native_gateway_downgrade');
  }
  if (url.username || url.password || url.search || url.hash) {
    fail('windows_native_gateway_url_credentials');
  }
  return url.href;
}

export class WindowsNativeDesktopClient {
  constructor({
    canvas,
    onState = () => {},
    onError = () => {},
    webSocketFactory = (url) => new globalThis.WebSocket(url),
    mediaFactory,
    inputFactory = (options) => new WindowsNativeInputEncoder(options),
  }) {
    if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
      fail('windows_native_canvas_required');
    }
    if (typeof onState !== 'function' || typeof onError !== 'function') {
      fail('windows_native_client_callback');
    }
    if (typeof webSocketFactory !== 'function' || typeof inputFactory !== 'function') {
      fail('windows_native_client_factory');
    }

    this.canvas = canvas;
    this.onState = onState;
    this.onError = onError;
    this.webSocketFactory = webSocketFactory;
    this.inputFactory = inputFactory;
    this.socket = null;
    this.input = null;
    this.streamEpoch = null;
    this.started = false;
    this.closed = false;
    this.mediaQueue = Promise.resolve();
    this.pressedKeys = new Set();
    this.pressedButtons = new Set();

    const renderer = new CanvasVideoFrameRenderer({
      canvas,
      onRendered: (metadata) => this.#onRendered(metadata),
    });
    this.renderer = renderer;
    this.media = mediaFactory
      ? mediaFactory({
          output: (frame, metadata) => renderer.render(frame, metadata),
          onError: (error) => this.#fatal(error),
        })
      : new WindowsNativeWebCodecsSession({
          output: (frame, metadata) => renderer.render(frame, metadata),
          onError: (error) => this.#fatal(error),
        });
    if (!this.media || typeof this.media.push !== 'function' || typeof this.media.close !== 'function') {
      fail('windows_native_media_session_required');
    }
  }

  #state(value) {
    this.onState(value);
  }

  #fatal(error) {
    if (this.closed) return;
    const safe = error instanceof Error ? error : new Error('windows_native_client_failed');
    this.onError(safe);
    this.close();
  }

  #send(frame) {
    if (
      !this.socket ||
      this.socket.readyState !== 1 ||
      !(frame instanceof Uint8Array)
    ) {
      fail('windows_native_input_channel_not_ready');
    }
    this.socket.send(frame);
  }

  #onRendered(metadata) {
    if (this.closed) return;
    if (this.streamEpoch !== metadata.streamEpoch) {
      // Release any held state through the old epoch before switching fences.
      // A reconnect/new stream must never strand a key/button in the renter OS.
      this.#releasePressedInput();
      this.streamEpoch = metadata.streamEpoch;
      this.input = this.inputFactory({
        streamEpoch: metadata.streamEpoch,
        send: (frame) => this.#send(frame),
      });
    }
    this.#state({
      state: 'ready',
      streamEpoch: metadata.streamEpoch,
      frameSequence: metadata.frameSequence,
      renderedFrames: metadata.renderedFrames,
      codec: metadata.codec,
    });
  }

  start(value, base = globalThis.location?.href) {
    if (this.started || this.closed) fail('windows_native_client_state');
    const url = sameOriginWebSocketUrl(value, base);
    const socket = this.webSocketFactory(url);
    if (!socket || typeof socket.addEventListener !== 'function' || typeof socket.send !== 'function') {
      fail('windows_native_websocket_required');
    }
    this.started = true;
    this.socket = socket;
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      if (!this.closed) this.#state({ state: 'connected' });
    });
    socket.addEventListener('message', (event) => {
      if (this.closed) return;
      if (
        !(event.data instanceof ArrayBuffer) &&
        !(event.data instanceof Uint8Array) &&
        !ArrayBuffer.isView(event.data)
      ) {
        this.#fatal(new Error('windows_native_media_binary_required'));
        return;
      }
      this.mediaQueue = this.mediaQueue
        .then(() => this.media.push(event.data))
        .catch((error) => this.#fatal(error));
    });
    socket.addEventListener('error', () => {
      this.#fatal(new Error('windows_native_gateway_socket_error'));
    });
    socket.addEventListener('close', () => {
      if (this.closed) return;
      this.#releasePressedInput();
      this.closed = true;
      this.media.close();
      this.#state({ state: 'closed' });
    });
    this.#state({ state: 'connecting' });
  }

  #requireInput() {
    if (!this.input || this.closed) return null;
    return this.input;
  }

  key(code, keyUp = false) {
    const input = this.#requireInput();
    if (!input) return false;
    const sent = input.key(code, keyUp);
    if (!sent) return false;
    if (keyUp) this.pressedKeys.delete(code);
    else this.pressedKeys.add(code);
    return true;
  }

  pointerAbsolute(clientX, clientY) {
    const input = this.#requireInput();
    if (!input) return false;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect || rect.width <= 1 || rect.height <= 1) return false;
    return input.mouseAbsolute(
      clientX - rect.left,
      clientY - rect.top,
      rect.width,
      rect.height,
    );
  }

  pointerButton(button, keyUp = false) {
    const input = this.#requireInput();
    if (!input) return false;
    const sent = input.mouseButton(button, keyUp);
    if (!sent) return false;
    if (keyUp) this.pressedButtons.delete(button);
    else this.pressedButtons.add(button);
    return true;
  }

  wheel(deltaY) {
    const input = this.#requireInput();
    if (!input || !Number.isFinite(deltaY) || deltaY === 0) return false;
    // Browser positive deltaY means scroll down; Win32 positive wheel delta is up.
    return input.mouseWheel(Math.round(-deltaY));
  }

  #releasePressedInput() {
    const input = this.input;
    if (!input || !this.socket || this.socket.readyState !== 1) {
      this.pressedKeys.clear();
      this.pressedButtons.clear();
      return;
    }
    for (const code of [...this.pressedKeys]) {
      try { input.key(code, true); } catch {}
    }
    for (const button of [...this.pressedButtons]) {
      try { input.mouseButton(button, true); } catch {}
    }
    this.pressedKeys.clear();
    this.pressedButtons.clear();
  }

  bindDom({ keyboardTarget = globalThis.document, pointerTarget = this.canvas } = {}) {
    if (
      !keyboardTarget ||
      typeof keyboardTarget.addEventListener !== 'function' ||
      !pointerTarget ||
      typeof pointerTarget.addEventListener !== 'function'
    ) {
      fail('windows_native_input_target');
    }

    if (typeof this.canvas.setAttribute === 'function') this.canvas.setAttribute('tabindex', '0');

    const keydown = (event) => {
      if (this.key(event.code, false)) event.preventDefault?.();
    };
    const keyup = (event) => {
      if (this.key(event.code, true)) event.preventDefault?.();
    };
    const pointermove = (event) => {
      if (this.pointerAbsolute(event.clientX, event.clientY)) event.preventDefault?.();
    };
    const pointerdown = (event) => {
      this.canvas.focus?.({ preventScroll: true });
      if (this.pointerAbsolute(event.clientX, event.clientY)) {
        this.pointerButton(event.button, false);
        try { pointerTarget.setPointerCapture?.(event.pointerId); } catch {}
        event.preventDefault?.();
      }
    };
    const pointerup = (event) => {
      if (this.pointerButton(event.button, true)) event.preventDefault?.();
    };
    const wheel = (event) => {
      if (this.wheel(event.deltaY)) event.preventDefault?.();
    };
    const contextmenu = (event) => event.preventDefault?.();
    const blur = () => this.#releasePressedInput();

    keyboardTarget.addEventListener('keydown', keydown);
    keyboardTarget.addEventListener('keyup', keyup);
    globalThis.addEventListener?.('blur', blur);
    pointerTarget.addEventListener('pointermove', pointermove);
    pointerTarget.addEventListener('pointerdown', pointerdown);
    pointerTarget.addEventListener('pointerup', pointerup);
    pointerTarget.addEventListener('pointercancel', pointerup);
    pointerTarget.addEventListener('wheel', wheel, { passive: false });
    pointerTarget.addEventListener('contextmenu', contextmenu);

    return () => {
      keyboardTarget.removeEventListener?.('keydown', keydown);
      keyboardTarget.removeEventListener?.('keyup', keyup);
      globalThis.removeEventListener?.('blur', blur);
      pointerTarget.removeEventListener?.('pointermove', pointermove);
      pointerTarget.removeEventListener?.('pointerdown', pointerdown);
      pointerTarget.removeEventListener?.('pointerup', pointerup);
      pointerTarget.removeEventListener?.('pointercancel', pointerup);
      pointerTarget.removeEventListener?.('wheel', wheel);
      pointerTarget.removeEventListener?.('contextmenu', contextmenu);
      this.#releasePressedInput();
    };
  }

  close() {
    if (this.closed) return;
    this.#releasePressedInput();
    this.closed = true;
    this.media.close();
    try {
      if (this.socket && this.socket.readyState < 2) this.socket.close(1000, 'client_close');
    } catch {}
    this.#state({ state: 'closed' });
  }
}
