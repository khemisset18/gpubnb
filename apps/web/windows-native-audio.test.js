import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_AUDIO_HEADER_SIZE,
  BROWSER_AUDIO_PROTOCOL_VERSION,
  BrowserAVClock,
  WindowsNativeAudioPlayback,
  parseWindowsNativeAudioPacket,
} from './windows-native-audio.js';

function audioPacket({
  format = 3,
  epoch = 1n,
  sequence = 1n,
  audioQpc = 1_000_000n,
  videoQpc = 1_000_000n,
  sampleRate = 48_000,
  channels = 1,
  frames = 2,
  flags = 0,
  payload = Uint8Array.from([0x00, 0x80, 0xff, 0x7f]),
} = {}) {
  const packet = new Uint8Array(BROWSER_AUDIO_HEADER_SIZE + payload.length);
  packet.set([0x47, 0x42, 0x4e, 0x41]);
  const view = new DataView(packet.buffer);
  view.setUint16(4, BROWSER_AUDIO_PROTOCOL_VERSION, true);
  view.setUint16(6, format, true);
  view.setBigUint64(8, epoch, true);
  view.setBigUint64(16, sequence, true);
  view.setBigUint64(24, audioQpc, true);
  view.setBigUint64(32, videoQpc, true);
  view.setUint32(40, sampleRate, true);
  view.setUint16(44, channels, true);
  view.setUint32(48, frames, true);
  view.setUint32(52, flags, true);
  view.setUint32(56, payload.length, true);
  packet.set(payload, BROWSER_AUDIO_HEADER_SIZE);
  return packet;
}

function fakeAudioContext() {
  const created = { buffers: [], sources: [], gains: [], resumed: 0, closed: 0, listeners: new Map() };
  const context = {
    currentTime: 2,
    state: 'suspended',
    destination: {},
    async resume() {
      created.resumed += 1;
      this.state = 'running';
      created.listeners.get('statechange')?.();
    },
    async close() {
      created.closed += 1;
      this.state = 'closed';
      created.listeners.get('statechange')?.();
    },
    addEventListener(type, listener) { created.listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (created.listeners.get(type) === listener) created.listeners.delete(type);
    },
    createBuffer(channels, frames, sampleRate) {
      const buffer = {
        channels,
        frames,
        sampleRate,
        data: Array.from({ length: channels }, () => new Float32Array(frames)),
        getChannelData(channel) { return this.data[channel]; },
      };
      created.buffers.push(buffer);
      return buffer;
    },
    createBufferSource() {
      const source = {
        connect(target) { this.target = target; },
        disconnect() { this.disconnected = true; },
        start(when) { this.startedAt = when; },
        stop() { this.stopped = true; },
      };
      created.sources.push(source);
      return source;
    },
    createGain() {
      const gain = {
        gain: {
          value: 1,
          setTargetAtTime(value) { this.value = value; },
        },
        connect(target) { this.target = target; },
        disconnect() { this.disconnected = true; },
      };
      created.gains.push(gain);
      return gain;
    },
  };
  return { context, created };
}

test('browser audio envelope validates version, PCM shape, clock, reserved bits, and silence', () => {
  const parsed = parseWindowsNativeAudioPacket(audioPacket());
  assert.equal(parsed.sampleFormat, 3);
  assert.equal(parsed.frames, 2);
  assert.equal(parsed.payload.length, 4);

  const badVersion = audioPacket();
  new DataView(badVersion.buffer).setUint16(4, 7, true);
  assert.throws(() => parseWindowsNativeAudioPacket(badVersion), /windows_native_audio_version/);

  const wrongLength = audioPacket({ payload: Uint8Array.from([1, 2]) });
  assert.throws(() => parseWindowsNativeAudioPacket(wrongLength), /windows_native_audio_payload_length/);

  const wrongSilence = audioPacket({ flags: 1, payload: Uint8Array.from([1, 0, 0, 0]) });
  assert.throws(() => parseWindowsNativeAudioPacket(wrongSilence), /windows_native_audio_silence/);

  const invalidTimestamp = audioPacket({ audioQpc: 0n });
  assert.throws(() => parseWindowsNativeAudioPacket(invalidTimestamp), /windows_native_audio_timestamp/);
  const futureAudio = audioPacket({ audioQpc: 1_000_001n, videoQpc: 1_000_000n });
  assert.throws(() => parseWindowsNativeAudioPacket(futureAudio), /windows_native_audio_timestamp/);
});

test('audio playback waits for a gesture, follows the shared QPC timeline, honors volume, and stops sources', async () => {
  const states = [];
  const clock = new BrowserAVClock({ latencyMs: 40, now: () => 100 });
  clock.observeVideo(1_000_000n, 100);
  const { context, created } = fakeAudioContext();
  const playback = new WindowsNativeAudioPlayback({
    clock,
    audioContextFactory: () => context,
    onState: (state) => states.push(state),
    now: () => 100,
  });
  playback.setStreamEpoch(1n);
  assert.equal(playback.push(audioPacket()), false);
  assert.equal(created.sources.length, 0);

  assert.equal(await playback.resume(), true);
  assert.equal(created.resumed, 1);
  assert.equal(created.sources.length, 1);
  assert.equal(created.sources[0].startedAt, 2.04);
  assert.ok(Math.abs(created.buffers[0].data[0][0] + 1) < 1e-6);
  assert.ok(Math.abs(created.buffers[0].data[0][1] - (32767 / 32768)) < 1e-6);

  playback.setVolume(0.4);
  assert.equal(created.gains[0].gain.value, 0.4);
  playback.close();
  assert.equal(created.sources[0].stopped, true);
  assert.equal(created.closed, 1);
  assert.ok(states.some((state) => state.audioState === 'enabled'));
  assert.ok(states.some((state) => state.audioState === 'closed'));
});

test('audio packet epoch mismatch and stale audio are rejected without scheduling sound', async () => {
  const clock = new BrowserAVClock({ latencyMs: 20, now: () => 1_000 });
  clock.observeVideo(1_000_000n, 100);
  const { context, created } = fakeAudioContext();
  const playback = new WindowsNativeAudioPlayback({
    clock,
    audioContextFactory: () => context,
    now: () => 1_000,
  });
  playback.setStreamEpoch(2n);
  assert.throws(() => playback.push(audioPacket({ epoch: 1n })), /windows_native_audio_epoch/);
  await playback.resume();
  playback.push(audioPacket({ epoch: 2n }));
  assert.equal(created.sources.length, 0);
  playback.close();
});

test('audio suspension and output-device changes stop queued sound until a fresh gesture', async () => {
  const states = [];
  const clock = new BrowserAVClock({ latencyMs: 40, now: () => 100 });
  clock.observeVideo(1_000_000n, 100);
  const { context, created } = fakeAudioContext();
  const deviceListeners = new Map();
  const mediaDevices = {
    addEventListener(type, listener) { deviceListeners.set(type, listener); },
    removeEventListener(type, listener) { if (deviceListeners.get(type) === listener) deviceListeners.delete(type); },
  };
  const playback = new WindowsNativeAudioPlayback({
    clock,
    audioContextFactory: () => context,
    mediaDevices,
    onState: (state) => states.push(state),
    now: () => 100,
  });
  playback.setStreamEpoch(1n);
  await playback.resume();
  playback.push(audioPacket());
  const firstSource = created.sources[0];
  assert.ok(firstSource);

  context.state = 'suspended';
  created.listeners.get('statechange')?.();
  assert.equal(firstSource.stopped, true);
  assert.ok(states.some((state) => state.audioState === 'blocked'));

  context.state = 'running';
  await playback.resume();
  playback.push(audioPacket({ sequence: 2n }));
  const secondSource = created.sources.at(-1);
  deviceListeners.get('devicechange')?.();
  assert.equal(secondSource.stopped, true);
  assert.ok(states.filter((state) => state.audioState === 'blocked').length >= 2);

  playback.push(audioPacket({ sequence: 3n }));
  const scheduledBeforeGesture = created.sources.length;
  await playback.resume();
  assert.equal(created.sources.length, scheduledBeforeGesture + 1);
  playback.close();
  assert.equal(deviceListeners.has('devicechange'), false);
});
