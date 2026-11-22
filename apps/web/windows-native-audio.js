'use strict';

export const BROWSER_AUDIO_PROTOCOL_VERSION = 1;
export const BROWSER_AUDIO_HEADER_SIZE = 64;
export const BROWSER_AUDIO_PACKET_MAX_BYTES = 512 * 1024;
export const BROWSER_AUDIO_MAX_BUFFERED_PACKETS = 32;
export const BROWSER_AUDIO_MAX_BUFFERED_BYTES = 1024 * 1024;

const MAGIC = [0x47, 0x42, 0x4e, 0x41]; // GBNA
const FLAG_SILENT = 1;
const FLAG_DISCONTINUITY = 2;

function fail(code) {
  throw new Error(code);
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  fail('windows_native_audio_packet_type');
}

function bytesPerSample(format) {
  switch (format) {
    case 1:
    case 5: return 4;
    case 2: return 1;
    case 3: return 2;
    case 4: return 3;
    default: fail('windows_native_audio_format');
  }
}

export function parseWindowsNativeAudioPacket(value) {
  const packet = asUint8Array(value);
  if (packet.byteLength < BROWSER_AUDIO_HEADER_SIZE) fail('windows_native_audio_packet_length');
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (packet[index] !== MAGIC[index]) fail('windows_native_audio_magic');
  }
  const view = new DataView(packet.buffer, packet.byteOffset, BROWSER_AUDIO_HEADER_SIZE);
  const protocolVersion = view.getUint16(4, true);
  const sampleFormat = view.getUint16(6, true);
  const streamEpoch = view.getBigUint64(8, true);
  const frameSequence = view.getBigUint64(16, true);
  const audioQpcPosition100ns = view.getBigUint64(24, true);
  const videoQpcPosition100ns = view.getBigUint64(32, true);
  const sampleRate = view.getUint32(40, true);
  const channels = view.getUint16(44, true);
  const reserved = view.getUint16(46, true);
  const frames = view.getUint32(48, true);
  const flags = view.getUint32(52, true);
  const payloadBytes = view.getUint32(56, true);
  const reservedTail = view.getUint32(60, true);

  if (protocolVersion !== BROWSER_AUDIO_PROTOCOL_VERSION) fail('windows_native_audio_version');
  if (sampleFormat < 1 || sampleFormat > 5) fail('windows_native_audio_format');
  if (streamEpoch === 0n) fail('windows_native_audio_epoch');
  if (frameSequence === 0n) fail('windows_native_audio_sequence');
  if (videoQpcPosition100ns === 0n || (audioQpcPosition100ns === 0n && (flags & FLAG_DISCONTINUITY) === 0)) {
    fail('windows_native_audio_timestamp');
  }
  if (audioQpcPosition100ns !== 0n && audioQpcPosition100ns > videoQpcPosition100ns) {
    fail('windows_native_audio_timestamp');
  }
  if (sampleRate < 8_000 || sampleRate > 192_000) fail('windows_native_audio_sample_rate');
  if (channels < 1 || channels > 8) fail('windows_native_audio_channels');
  if (reserved !== 0 || reservedTail !== 0 || (flags & ~(FLAG_SILENT | FLAG_DISCONTINUITY)) !== 0) {
    fail('windows_native_audio_flags');
  }
  if (frames === 0) fail('windows_native_audio_frames');

  const payload = packet.subarray(BROWSER_AUDIO_HEADER_SIZE);
  const expectedBytes = frames * channels * bytesPerSample(sampleFormat);
  if (!Number.isSafeInteger(expectedBytes) || payloadBytes === 0 ||
      payloadBytes > BROWSER_AUDIO_PACKET_MAX_BYTES || payload.byteLength !== payloadBytes ||
      payloadBytes !== expectedBytes || packet.byteLength !== BROWSER_AUDIO_HEADER_SIZE + payloadBytes) {
    fail('windows_native_audio_payload_length');
  }
  const silent = (flags & FLAG_SILENT) !== 0;
  if (silent) {
    const silenceByte = sampleFormat === 2 ? 0x80 : 0;
    for (const byte of payload) {
      if (byte !== silenceByte) fail('windows_native_audio_silence');
    }
  }
  return {
    protocolVersion,
    sampleFormat,
    streamEpoch,
    frameSequence,
    audioQpcPosition100ns,
    videoQpcPosition100ns,
    sampleRate,
    channels,
    frames,
    silent,
    discontinuity: (flags & FLAG_DISCONTINUITY) !== 0,
    payload,
  };
}

/** Maps the shared host QPC clock onto browser presentation clocks. */
export class BrowserAVClock {
  constructor({ latencyMs = 80, now = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
    if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 500 || typeof now !== 'function') {
      fail('windows_native_av_clock_config');
    }
    this.latencyMs = latencyMs;
    this.now = now;
    this.hostQpcAnchor = null;
    this.performanceAnchorMs = null;
    this.audioContextAnchorTime = null;
    this.audioPerformanceAnchorMs = null;
  }

  observeVideo(qpcPosition100ns, receivedAtMs = this.now()) {
    if (typeof qpcPosition100ns !== 'bigint' || qpcPosition100ns <= 0n || !Number.isFinite(receivedAtMs)) {
      fail('windows_native_audio_timestamp');
    }
    if (this.hostQpcAnchor === null) {
      this.hostQpcAnchor = qpcPosition100ns;
      this.performanceAnchorMs = receivedAtMs + this.latencyMs;
    }
  }

  performanceTimeFor(qpcPosition100ns) {
    if (this.hostQpcAnchor === null || typeof qpcPosition100ns !== 'bigint' || qpcPosition100ns <= 0n) {
      fail('windows_native_audio_clock_unanchored');
    }
    const delta = Number(qpcPosition100ns - this.hostQpcAnchor);
    if (!Number.isSafeInteger(delta)) fail('windows_native_audio_clock_range');
    return this.performanceAnchorMs + delta / 10_000;
  }

  audioContextTimeFor(qpcPosition100ns, context, nowMs = this.now()) {
    if (!context || !Number.isFinite(context.currentTime) || !Number.isFinite(nowMs)) {
      fail('windows_native_audio_context');
    }
    if (this.audioContextAnchorTime === null) {
      this.audioContextAnchorTime = context.currentTime;
      this.audioPerformanceAnchorMs = nowMs;
    }
    return this.audioContextAnchorTime + (this.performanceTimeFor(qpcPosition100ns) - this.audioPerformanceAnchorMs) / 1000;
  }

  reset() {
    this.hostQpcAnchor = null;
    this.performanceAnchorMs = null;
    this.audioContextAnchorTime = null;
    this.audioPerformanceAnchorMs = null;
  }
}

function normalizedSample(view, sampleFormat, byteOffset) {
  switch (sampleFormat) {
    case 1: {
      const value = view.getFloat32(byteOffset, true);
      return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }
    case 2: return (view.getUint8(byteOffset) - 128) / 128;
    case 3: return view.getInt16(byteOffset, true) / 32768;
    case 4: {
      let value = view.getUint8(byteOffset) |
        (view.getUint8(byteOffset + 1) << 8) |
        (view.getUint8(byteOffset + 2) << 16);
      if (value & 0x800000) value -= 0x1000000;
      return value / 8388608;
    }
    case 5: return view.getInt32(byteOffset, true) / 2147483648;
    default: fail('windows_native_audio_format');
  }
}

/** Plays bounded PCM packets while promptly clearing them on stream loss or STOP. */
export class WindowsNativeAudioPlayback {
  constructor({
    clock,
    audioContextFactory = () => {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof AudioContextClass !== 'function') fail('windows_native_audio_unavailable');
      return new AudioContextClass({ latencyHint: 'interactive' });
    },
    mediaDevices = globalThis.navigator?.mediaDevices ?? null,
    onState = () => {},
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    maxBufferedPackets = BROWSER_AUDIO_MAX_BUFFERED_PACKETS,
    maxBufferedBytes = BROWSER_AUDIO_MAX_BUFFERED_BYTES,
    maxStaleMs = 150,
  } = {}) {
    if (!clock || typeof clock.audioContextTimeFor !== 'function' ||
        typeof audioContextFactory !== 'function' || typeof onState !== 'function' || typeof now !== 'function') {
      fail('windows_native_audio_config');
    }
    if (!Number.isSafeInteger(maxBufferedPackets) || maxBufferedPackets <= 0 ||
        !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < BROWSER_AUDIO_PACKET_MAX_BYTES ||
        !Number.isFinite(maxStaleMs) || maxStaleMs < 0) {
      fail('windows_native_audio_config');
    }
    this.clock = clock;
    this.audioContextFactory = audioContextFactory;
    this.mediaDevices = mediaDevices;
    this.onState = onState;
    this.now = now;
    this.maxBufferedPackets = maxBufferedPackets;
    this.maxBufferedBytes = maxBufferedBytes;
    this.maxStaleMs = maxStaleMs;
    this.expectedStreamEpoch = null;
    this.context = null;
    this.contextStateHandler = null;
    this.deviceChangeHandler = () => this.#handleDeviceChange();
    this.sources = new Set();
    this.pending = [];
    this.pendingBytes = 0;
    this.nextAudioTime = null;
    this.volume = 1;
    this.awaitingGesture = true;
    this.closed = false;
    this.mediaDevices?.addEventListener?.('devicechange', this.deviceChangeHandler);
  }

  setStreamEpoch(streamEpoch) {
    if (typeof streamEpoch !== 'bigint' || streamEpoch <= 0n) fail('windows_native_audio_epoch');
    if (this.expectedStreamEpoch === streamEpoch) return;
    this.#stopSources();
    this.pending = [];
    this.pendingBytes = 0;
    this.nextAudioTime = null;
    this.expectedStreamEpoch = streamEpoch;
  }

  async resume() {
    if (this.closed) return false;
    if (!this.context || this.context.state === 'closed') this.#createContext();
    if (!this.context || typeof this.context.resume !== 'function' ||
        typeof this.context.createBuffer !== 'function' || typeof this.context.createBufferSource !== 'function') {
      fail('windows_native_audio_context');
    }
    await this.context.resume();
    if (this.context.state && this.context.state !== 'running') {
      this.awaitingGesture = true;
      this.onState({ audioState: 'blocked' });
      return false;
    }
    this.awaitingGesture = false;
    // A new mapping is required after browser suspension or device changes.
    this.clock.audioContextAnchorTime = this.context.currentTime;
    this.clock.audioPerformanceAnchorMs = this.now();
    const pending = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const packet of pending) this.#play(packet);
    this.onState({ audioState: 'enabled' });
    return true;
  }

  setVolume(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) fail('windows_native_audio_volume');
    this.volume = value;
    for (const source of this.sources) {
      try { source.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.02); } catch {}
    }
  }

  push(value) {
    if (this.closed) return false;
    const packet = parseWindowsNativeAudioPacket(value);
    if (this.expectedStreamEpoch === null || packet.streamEpoch !== this.expectedStreamEpoch) {
      fail('windows_native_audio_epoch');
    }
    if (this.awaitingGesture || !this.context || (this.context.state && this.context.state !== 'running')) {
      const copy = { ...packet, payload: packet.payload.slice() };
      this.pending.push(copy);
      this.pendingBytes += copy.payload.byteLength;
      while (this.pending.length > this.maxBufferedPackets || this.pendingBytes > this.maxBufferedBytes) {
        const dropped = this.pending.shift();
        this.pendingBytes -= dropped.payload.byteLength;
      }
      this.onState({ audioState: 'waiting-for-gesture' });
      return false;
    }
    return this.#play(packet);
  }

  #play(packet) {
    const context = this.context;
    if (this.awaitingGesture || !context || context.state && context.state !== 'running') return false;
    const qpc = packet.audioQpcPosition100ns || packet.videoQpcPosition100ns;
    const targetPerformanceMs = this.clock.performanceTimeFor(qpc);
    const nowMs = this.now();
    const durationSeconds = packet.frames / packet.sampleRate;
    if (targetPerformanceMs + durationSeconds * 1000 < nowMs - this.maxStaleMs) {
      this.onState({ audioState: 'dropping-stale' });
      return false;
    }

    const buffer = context.createBuffer(packet.channels, packet.frames, packet.sampleRate);
    const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength);
    const sampleSize = bytesPerSample(packet.sampleFormat);
    for (let channel = 0; channel < packet.channels; channel += 1) {
      const channelData = buffer.getChannelData(channel);
      for (let frame = 0; frame < packet.frames; frame += 1) {
        const sample = frame * packet.channels + channel;
        channelData[frame] = packet.silent ? 0 : normalizedSample(view, packet.sampleFormat, sample * sampleSize);
      }
    }

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = this.volume;
    source.connect(gain);
    gain.connect(context.destination);
    if (packet.discontinuity) this.nextAudioTime = null;
    const targetTime = this.clock.audioContextTimeFor(qpc, context, nowMs);
    const when = Math.max(targetTime, context.currentTime + 0.015, this.nextAudioTime ?? 0);
    const record = { source, gain };
    this.sources.add(record);
    source.onended = () => {
      this.sources.delete(record);
      try { source.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    };
    source.start(when);
    this.nextAudioTime = when + durationSeconds;
    this.onState({ audioState: 'playing' });
    return true;
  }

  #stopSources() {
    for (const { source, gain } of this.sources) {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    }
    this.sources.clear();
  }

  #createContext() {
    const previous = this.context;
    if (previous && this.contextStateHandler) {
      try { previous.removeEventListener?.('statechange', this.contextStateHandler); } catch {}
    }
    const context = this.audioContextFactory();
    if (!context) fail('windows_native_audio_context');
    this.context = context;
    this.contextStateHandler = () => {
      if (this.closed || this.context !== context) return;
      if (context.state === 'running' && !this.awaitingGesture) {
        this.clock.audioContextAnchorTime = context.currentTime;
        this.clock.audioPerformanceAnchorMs = this.now();
        this.nextAudioTime = null;
        this.onState({ audioState: 'enabled' });
        return;
      }
      if (context.state !== 'running') {
        this.awaitingGesture = true;
        this.nextAudioTime = null;
        this.#stopSources();
        this.onState({ audioState: 'blocked' });
      }
    };
    context.addEventListener?.('statechange', this.contextStateHandler);
  }

  #handleDeviceChange() {
    if (this.closed || !this.context) return;
    // Drop audio scheduled against the old output clock. Require a fresh
    // user gesture so the browser can rebind its output after a device switch.
    this.awaitingGesture = true;
    this.nextAudioTime = null;
    this.#stopSources();
    this.onState({ audioState: 'blocked' });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.nextAudioTime = null;
    this.#stopSources();
    const context = this.context;
    if (context && this.contextStateHandler) {
      try { context.removeEventListener?.('statechange', this.contextStateHandler); } catch {}
    }
    this.contextStateHandler = null;
    this.context = null;
    try { this.mediaDevices?.removeEventListener?.('devicechange', this.deviceChangeHandler); } catch {}
    try { Promise.resolve(context?.close?.()).catch(() => {}); } catch {}
    this.onState({ audioState: 'closed' });
  }
}
