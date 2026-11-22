'use strict';

import { WindowsNativeGamepadBridge } from './windows-native-gamepad.js?v=20261122-1';
import { BrowserAVClock, WindowsNativeAudioPlayback } from './windows-native-audio.js?v=20261122-audio-2';
import {
  CanvasVideoFrameRenderer,
  WindowsNativeWebCodecsSession,
} from './windows-native-media.js?v=20261122-av-audio-1';
import {
  WindowsNativeInputEncoder,
} from './windows-native-input.js?v=20261003-input-arraybuffer-1';

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
    audioFactory = (options) => new WindowsNativeAudioPlayback(options),
    avClockFactory = (options) => new BrowserAVClock(options),
    inputFactory = (options) => new WindowsNativeInputEncoder(options),
  }) {
    if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
      fail('windows_native_canvas_required');
    }
    if (typeof onState !== 'function' || typeof onError !== 'function') {
      fail('windows_native_client_callback');
    }
    if (typeof webSocketFactory !== 'function' || typeof inputFactory !== 'function' ||
        typeof audioFactory !== 'function' || typeof avClockFactory !== 'function') {
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
    // WebSocket 'error' precedes 'close'; block all input and decoding at the
    // first transport failure, but retain the later CloseEvent's real code.
    this.socketError = false;
    this.mediaQueue = Promise.resolve();
    this.pressedKeys = new Set();
    this.pressedButtons = new Set();
    this.avClock = avClockFactory({ latencyMs: 80 });
    if (!this.avClock || typeof this.avClock.observeVideo !== 'function') {
      fail('windows_native_av_clock_config');
    }
    this.pendingVideoFrames = new Set();

    const renderer = new CanvasVideoFrameRenderer({
      canvas,
      onRendered: (metadata) => this.#onRendered(metadata),
    });
    this.renderer = renderer;
    const outputFrame = (frame, metadata) => {
      if (this.closed || this.socketError) {
        // Decoder output may still arrive asynchronously after authority is
        // revoked. Never paint a late frame, and release its GPU resources.
        try { frame?.close?.(); } catch {}
        return;
      }
      const dueAt = metadata?.presentationTimeMs;
      const now = globalThis.performance?.now?.() ?? Date.now();
      if (!Number.isFinite(dueAt)) {
        // Custom test and diagnostic media adapters may not carry a host clock.
        renderer.render(frame, metadata);
        return;
      }
      if (dueAt < now - 150) {
        try { frame?.close?.(); } catch {}
        return;
      }
      const pending = { frame, timer: null };
      this.pendingVideoFrames.add(pending);
      const render = () => {
        this.pendingVideoFrames.delete(pending);
        if (this.closed || this.socketError) {
          try { frame?.close?.(); } catch {}
          return;
        }
        renderer.render(frame, metadata);
      };
      const delay = dueAt - now;
      if (delay > 2) pending.timer = globalThis.setTimeout(render, delay);
      else render();
    };
    this.media = mediaFactory
      ? mediaFactory({
          output: outputFrame,
          onError: (error) => this.#fatal(error),
        })
      : new WindowsNativeWebCodecsSession({
          output: outputFrame,
          onError: (error) => this.#fatal(error),
          clock: this.avClock,
        });
    if (!this.media || typeof this.media.push !== 'function' || typeof this.media.close !== 'function') {
      fail('windows_native_media_session_required');
    }
    this.audio = audioFactory({
      clock: this.avClock,
      onState: (state) => this.#state(state),
    });
    if (!this.audio || typeof this.audio.push !== 'function' ||
        typeof this.audio.close !== 'function' || typeof this.audio.resume !== 'function' ||
        typeof this.audio.setStreamEpoch !== 'function' || typeof this.audio.setVolume !== 'function') {
      fail('windows_native_audio_session_required');
    }
  }

  #state(value) {
    this.onState(value);
  }

  #fatal(error) {
    // Ignore decoder/queue fallout from a socket error: only the browser's
    // subsequent CloseEvent may classify transport closure (1006/1008/etc.).
    if (this.closed || this.socketError) return;
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
    // Blob is always emitted as a binary WebSocket message by browsers.
    // Keep a detached byte copy so the fixed native input frame cannot be
    // mutated after send().
    this.socket.send(new Blob([frame.slice()], { type: 'application/octet-stream' }));
  }

  #blackout() {
    // An expired/revoked viewer must not keep showing the last decoded image.
    // The 2D canvas uses alpha:false, so clearing restores opaque black.
    // Do not block transport cleanup if graphics context was lost.
    try { this.renderer.context?.clearRect?.(0, 0, this.canvas.width, this.canvas.height); } catch {}
  }

  #clearPendingVideoFrames() {
    for (const pending of this.pendingVideoFrames) {
      if (pending.timer !== null) {
        try { globalThis.clearTimeout(pending.timer); } catch {}
      }
      try { pending.frame?.close?.(); } catch {}
    }
    this.pendingVideoFrames.clear();
  }

  #onRendered(metadata) {
    if (this.closed || this.socketError) return;
    if (this.streamEpoch !== metadata.streamEpoch) {
      // Release any held state through the old epoch before switching fences.
      // A reconnect/new stream must never strand a key/button in the renter OS.
      this.#releasePressedInput();
      this.streamEpoch = metadata.streamEpoch;
      this.audio.setStreamEpoch(metadata.streamEpoch);
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
      if (!this.closed && !this.socketError) this.#state({ state: 'connected' });
    });
    socket.addEventListener('message', (event) => {
      if (this.closed || this.socketError) return;
      if (
        !(event.data instanceof ArrayBuffer) &&
        !(event.data instanceof Uint8Array) &&
        !ArrayBuffer.isView(event.data)
      ) {
        this.#fatal(new Error('windows_native_media_binary_required'));
        return;
      }
      this.mediaQueue = this.mediaQueue
        .then(() => {
          // A previously enqueued packet must not decode after an error or
          // revoked input boundary, even when the promise settles later.
          if (this.closed || this.socketError) return;
          const bytes = event.data instanceof Uint8Array
            ? event.data
            : new Uint8Array(event.data instanceof ArrayBuffer
              ? event.data
              : event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength));
          if (bytes[0] === 0x47 && bytes[1] === 0x42 && bytes[2] === 0x4e && bytes[3] === 0x41) {
            const epoch = this.media.streamEpoch;
            if (typeof epoch === 'bigint') this.audio.setStreamEpoch(epoch);
            this.audio.push(bytes);
            return;
          }
          return Promise.resolve(this.media.push(event.data)).then((result) => {
            const epoch = this.media.streamEpoch;
            if (typeof epoch === 'bigint') this.audio.setStreamEpoch(epoch);
            return result;
          });
        })
        .catch((error) => this.#fatal(error));
    });
    socket.addEventListener('error', () => {
      if (this.closed || this.socketError) return;
      this.socketError = true;
      // Disable all incoming media and renter input immediately, without
      // initiating a synthetic 1000 close that would hide the actual 1006/1008.
      this.#releasePressedInput();
      this.input = null;
      this.#clearPendingVideoFrames();
      this.media.close();
      this.audio.close();
      this.#blackout();
      this.onError(new Error('windows_native_gateway_socket_error'));
      // Per WebSocket, the actual CloseEvent follows an error. The close
      // listener owns state transition and retry/policy decisions.
    });
    socket.addEventListener('close', (event) => {
      if (this.closed) return;
      if (!this.socketError) this.#releasePressedInput();
      this.closed = true;
      this.#clearPendingVideoFrames();
      if (!this.socketError) this.media.close();
      this.audio.close();
      this.#blackout();
      // Only bounded standard close metadata crosses the UI boundary: never
      // emit a peer-supplied reason, URL, capability, cookie or frame bytes.
      const closeCode = Number.isInteger(event?.code) && event.code >= 1000 && event.code <= 4999
        ? event.code : null;
      this.#state({ state: 'closed', closeCode, wasClean: event?.wasClean === true });
    });
    this.#state({ state: 'connecting' });
  }

  #requireInput() {
    if (!this.input || this.closed || this.socketError) return null;
    return this.input;
  }

  async enableAudio() {
    if (this.closed || this.socketError) return false;
    try {
      return await this.audio.resume();
    } catch {
      // Browser output/autoplay failures are local audio state, not a reason
      // to tear down an otherwise authorized video and input session.
      this.#state({ audioState: 'blocked' });
      return false;
    }
  }

  setAudioVolume(value) {
    this.audio.setVolume(value);
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

  mouseRelative(dx, dy) {
    const input = this.#requireInput();
    if (!input || typeof input.mouseRelative !== 'function') return false;
    // Browser gamepad aims through the same bounded, epoch-fenced input encoder.
    if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy) ||
        Math.abs(dx) > 14 || Math.abs(dy) > 14 || (dx === 0 && dy === 0)) return false;
    return input.mouseRelative(dx, dy);
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

    // The browser page has its own controls. Forward input to Windows only
    // after the renter explicitly focuses the remote canvas; otherwise a key
    // typed while navigating the site may accidentally operate the rented PC.
    // Losing focus always releases held input through the current stream epoch.
    let keyboardArmed = false;
    // Compatibility mode: standard Gamepad API -> ordinary keyboard/mouse.
    // There is intentionally no virtual XInput injection or new privileged
    // protocol. The gamepad is polled only while the renter focuses the canvas.
    const gamepad = new WindowsNativeGamepadBridge({
      key: (code, up) => this.key(code, up),
      pointerButton: (button, up) => this.pointerButton(button, up),
      mouseRelative: (dx, dy) => this.mouseRelative(dx, dy),
    });
    let gamepadFrame = null;
    const pumpGamepad = () => {
      gamepadFrame = null;
      if (!keyboardArmed || this.closed || this.socketError || keyboardTarget.hidden === true) {
        gamepad.release();
        return;
      }
      let pads = [];
      try { pads = globalThis.navigator?.getGamepads?.() ?? []; } catch {}
      try { gamepad.update(pads); } catch {
        // A revoked or failed input transport must stop gamepad polling rather
        // than continue to inject held commands on a later frame.
        disarmKeyboard();
        return;
      }
      if (typeof globalThis.requestAnimationFrame === 'function') {
        gamepadFrame = globalThis.requestAnimationFrame(pumpGamepad);
      }
    };
    const disarmKeyboard = () => {
      keyboardArmed = false;
      if (gamepadFrame !== null) {
        globalThis.cancelAnimationFrame?.(gamepadFrame);
        gamepadFrame = null;
      }
      gamepad.release();
      this.#releasePressedInput();
    };
    const focusCanvas = () => {
      if (keyboardTarget.hidden === true) return;
      // AudioContext playback is gated by browser policy until a user gesture.
      // Calling resume directly in the focus/pointer gesture keeps the game
      // audio path usable without autoplay exceptions.
      void this.enableAudio();
      keyboardArmed = true;
      if (gamepadFrame === null && typeof globalThis.requestAnimationFrame === 'function') {
        gamepadFrame = globalThis.requestAnimationFrame(pumpGamepad);
      }
    };
    const focusMoved = (event) => {
      if (event?.target === this.canvas) focusCanvas();
      else disarmKeyboard();
    };
    const visibilityChanged = () => {
      if (keyboardTarget.hidden === true) disarmKeyboard();
    };
    const keydown = (event) => {
      if (keyboardArmed && this.key(event.code, false)) event.preventDefault?.();
    };
    const keyup = (event) => {
      if (keyboardArmed && this.key(event.code, true)) event.preventDefault?.();
    };
    const documentTarget = pointerTarget.ownerDocument || keyboardTarget;
    let pointerLocked = documentTarget.pointerLockElement === this.canvas;
    const pointerRelative = (dx, dy) => {
      const input = this.#requireInput();
      if (!input || typeof input.mouseRelative !== 'function' ||
          !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
      // Pointer-lock deltas are browser supplied. Bound each event before it
      // reaches the existing epoch-fenced native input protocol.
      const x = Math.max(-4096, Math.min(4096, Math.trunc(dx)));
      const y = Math.max(-4096, Math.min(4096, Math.trunc(dy)));
      if (x === 0 && y === 0) return false;
      return input.mouseRelative(x, y);
    };
    const pointerLockChanged = () => {
      const locked = documentTarget.pointerLockElement === this.canvas;
      if (locked) {
        pointerLocked = true;
        focusCanvas();
      } else if (pointerLocked) {
        pointerLocked = false;
        // Escape or browser policy can release pointer lock asynchronously.
        // Release all held native input before requiring another canvas click.
        disarmKeyboard();
      }
    };
    const pointermove = (event) => {
      if (!keyboardArmed) return;
      const accepted = pointerLocked
        ? pointerRelative(event.movementX, event.movementY)
        : this.pointerAbsolute(event.clientX, event.clientY);
      if (accepted) event.preventDefault?.();
    };
    const pointerdown = (event) => {
      this.canvas.focus?.({ preventScroll: true });
      focusCanvas();
      if (this.pointerAbsolute(event.clientX, event.clientY)) {
        this.pointerButton(event.button, false);
        try { pointerTarget.setPointerCapture?.(event.pointerId); } catch {}
        event.preventDefault?.();
      }
    };
    const pointerup = (event) => {
      if (keyboardArmed && this.pointerButton(event.button, true)) event.preventDefault?.();
    };
    const wheel = (event) => {
      if (keyboardArmed && this.wheel(event.deltaY)) event.preventDefault?.();
    };
    const contextmenu = (event) => event.preventDefault?.();
    const blur = () => disarmKeyboard();

    keyboardTarget.addEventListener('keydown', keydown);
    keyboardTarget.addEventListener('keyup', keyup);
    keyboardTarget.addEventListener('focusin', focusMoved);
    keyboardTarget.addEventListener('visibilitychange', visibilityChanged);
    documentTarget.addEventListener?.('pointerlockchange', pointerLockChanged);
    pointerTarget.addEventListener('focus', focusCanvas);
    pointerTarget.addEventListener('blur', blur);
    pointerTarget.addEventListener('lostpointercapture', blur);
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
      keyboardTarget.removeEventListener?.('focusin', focusMoved);
      keyboardTarget.removeEventListener?.('visibilitychange', visibilityChanged);
      documentTarget.removeEventListener?.('pointerlockchange', pointerLockChanged);
      pointerTarget.removeEventListener?.('focus', focusCanvas);
      pointerTarget.removeEventListener?.('blur', blur);
      pointerTarget.removeEventListener?.('lostpointercapture', blur);
      globalThis.removeEventListener?.('blur', blur);
      pointerTarget.removeEventListener?.('pointermove', pointermove);
      pointerTarget.removeEventListener?.('pointerdown', pointerdown);
      pointerTarget.removeEventListener?.('pointerup', pointerup);
      pointerTarget.removeEventListener?.('pointercancel', pointerup);
      pointerTarget.removeEventListener?.('wheel', wheel);
      pointerTarget.removeEventListener?.('contextmenu', contextmenu);
      disarmKeyboard();
      if (documentTarget.pointerLockElement === this.canvas) {
        try { documentTarget.exitPointerLock?.(); } catch {}
      }
    };
  }

  close() {
    if (this.closed) return;
    this.#releasePressedInput();
    this.closed = true;
    this.#clearPendingVideoFrames();
    if (!this.socketError) this.media.close();
    this.audio.close();
    this.#blackout();
    try {
      if (this.socket && this.socket.readyState < 2) this.socket.close(1000, 'client_close');
    } catch {}
    this.#state({ state: 'closed' });
  }
}
