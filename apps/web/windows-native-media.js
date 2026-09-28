'use strict';

export const BROWSER_MEDIA_PROTOCOL_VERSION = 1;
export const BROWSER_MEDIA_HEADER_SIZE = 44;
export const BROWSER_MEDIA_FRAME_MAX_BYTES = 8 * 1024 * 1024;
export const BROWSER_MEDIA_CHUNK_MAX_BYTES = 1024 * 1024;
export const BROWSER_MEDIA_CODEC_H264 = 1;
export const BROWSER_MEDIA_FLAG_KEYFRAME = 0x01;
export const BROWSER_MEDIA_REASSEMBLY_TIMEOUT_MS = 2_000;

const MAGIC = [0x47, 0x42, 0x4e, 0x4d]; // GBNM

function fail(code) {
  throw new Error(code);
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  fail('windows_native_media_packet_type');
}

export function parseWindowsNativeMediaPacket(value) {
  const packet = asUint8Array(value);
  if (packet.byteLength < BROWSER_MEDIA_HEADER_SIZE) fail('windows_native_media_packet_length');
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (packet[i] !== MAGIC[i]) fail('windows_native_media_magic');
  }

  const view = new DataView(packet.buffer, packet.byteOffset, BROWSER_MEDIA_HEADER_SIZE);
  const protocolVersion = view.getUint16(4, true);
  const codec = view.getUint8(6);
  const flags = view.getUint8(7);
  const streamEpoch = view.getBigUint64(8, true);
  const frameSequence = view.getBigUint64(16, true);
  const width = view.getUint32(24, true);
  const height = view.getUint32(28, true);
  const frameBytes = view.getUint32(32, true);
  const chunkOffset = view.getUint32(36, true);
  const chunkBytes = view.getUint32(40, true);

  if (protocolVersion !== BROWSER_MEDIA_PROTOCOL_VERSION) fail('windows_native_media_version');
  if (codec !== BROWSER_MEDIA_CODEC_H264) fail('windows_native_media_codec');
  if ((flags & ~BROWSER_MEDIA_FLAG_KEYFRAME) !== 0) fail('windows_native_media_flags');
  if (streamEpoch === 0n) fail('windows_native_media_epoch');
  if (frameSequence === 0n) fail('windows_native_media_sequence');
  if (width < 640 || width > 7680 || height < 480 || height > 4320) {
    fail('windows_native_media_dimensions');
  }
  if (frameBytes === 0 || frameBytes > BROWSER_MEDIA_FRAME_MAX_BYTES) {
    fail('windows_native_media_frame_length');
  }
  if (chunkBytes === 0 || chunkBytes > BROWSER_MEDIA_CHUNK_MAX_BYTES) {
    fail('windows_native_media_chunk_length');
  }

  const end = chunkOffset + chunkBytes;
  if (!Number.isSafeInteger(end) || chunkOffset >= frameBytes || end > frameBytes) {
    fail('windows_native_media_chunk_range');
  }
  if (packet.byteLength !== BROWSER_MEDIA_HEADER_SIZE + chunkBytes) {
    fail('windows_native_media_packet_length');
  }

  return {
    protocolVersion,
    codec,
    flags,
    streamEpoch,
    frameSequence,
    width,
    height,
    frameBytes,
    chunkOffset,
    chunkBytes,
    keyframe: (flags & BROWSER_MEDIA_FLAG_KEYFRAME) !== 0,
    payload: packet.subarray(BROWSER_MEDIA_HEADER_SIZE),
  };
}

export class WindowsNativeMediaReassembler {
  constructor({ timeoutMs = BROWSER_MEDIA_REASSEMBLY_TIMEOUT_MS } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      fail('windows_native_media_timeout_invalid');
    }
    this.timeoutMs = timeoutMs;
    this.pending = null;
    this.lastCompleted = null;
    this.requireKeyframe = true;
  }

  reset() {
    this.pending = null;
    this.requireKeyframe = true;
  }

  #reject(code) {
    this.reset();
    fail(code);
  }

  push(value, nowMs = globalThis.performance?.now?.() ?? Date.now()) {
    if (!Number.isFinite(nowMs)) this.#reject('windows_native_media_clock');

    if (this.pending && nowMs - this.pending.startedAtMs > this.timeoutMs) {
      this.#reject('windows_native_media_timeout');
    }

    let chunk;
    try {
      chunk = parseWindowsNativeMediaPacket(value);
    } catch (error) {
      this.reset();
      throw error;
    }

    if (
      this.pending &&
      (chunk.streamEpoch !== this.pending.streamEpoch ||
        chunk.frameSequence !== this.pending.frameSequence)
    ) {
      if (
        chunk.streamEpoch > this.pending.streamEpoch &&
        chunk.chunkOffset === 0 &&
        chunk.keyframe
      ) {
        this.pending = null;
        this.requireKeyframe = true;
      } else {
        this.#reject('windows_native_media_frame_order');
      }
    }

    if (this.pending) {
      if (
        chunk.width !== this.pending.width ||
        chunk.height !== this.pending.height ||
        chunk.frameBytes !== this.pending.frameBytes ||
        chunk.flags !== this.pending.flags
      ) {
        this.#reject('windows_native_media_frame_mismatch');
      }
      if (chunk.chunkOffset !== this.pending.nextOffset) {
        this.#reject('windows_native_media_frame_order');
      }
    } else {
      if (chunk.chunkOffset !== 0) this.#reject('windows_native_media_frame_order');

      if (this.lastCompleted) {
        if (chunk.streamEpoch < this.lastCompleted.streamEpoch) {
          this.#reject('windows_native_media_frame_order');
        }
        if (chunk.streamEpoch === this.lastCompleted.streamEpoch) {
          if (chunk.frameSequence !== this.lastCompleted.frameSequence + 1n) {
            this.#reject('windows_native_media_frame_order');
          }
        } else {
          this.requireKeyframe = true;
        }
      }

      if (this.requireKeyframe && !chunk.keyframe) {
        this.#reject('windows_native_media_keyframe_required');
      }

      this.pending = {
        streamEpoch: chunk.streamEpoch,
        frameSequence: chunk.frameSequence,
        width: chunk.width,
        height: chunk.height,
        frameBytes: chunk.frameBytes,
        flags: chunk.flags,
        nextOffset: 0,
        startedAtMs: nowMs,
        bytes: new Uint8Array(chunk.frameBytes),
      };
    }

    this.pending.bytes.set(chunk.payload, chunk.chunkOffset);
    this.pending.nextOffset += chunk.chunkBytes;

    if (this.pending.nextOffset < this.pending.frameBytes) return null;
    if (this.pending.nextOffset !== this.pending.frameBytes) {
      this.#reject('windows_native_media_chunk_range');
    }

    const completed = this.pending;
    this.pending = null;
    this.lastCompleted = {
      streamEpoch: completed.streamEpoch,
      frameSequence: completed.frameSequence,
    };
    this.requireKeyframe = false;

    return {
      streamEpoch: completed.streamEpoch,
      frameSequence: completed.frameSequence,
      width: completed.width,
      height: completed.height,
      keyframe: (completed.flags & BROWSER_MEDIA_FLAG_KEYFRAME) !== 0,
      bytes: completed.bytes,
    };
  }
}

export class BoundedWebCodecsH264Consumer {
  constructor({
    decoder,
    chunkFactory = (init) => {
      if (typeof globalThis.EncodedVideoChunk !== 'function') {
        fail('windows_native_webcodecs_unavailable');
      }
      return new globalThis.EncodedVideoChunk(init);
    },
    maxDecodeQueue = 4,
    timeoutMs = BROWSER_MEDIA_REASSEMBLY_TIMEOUT_MS,
  }) {
    if (!decoder || typeof decoder.decode !== 'function') {
      fail('windows_native_decoder_required');
    }
    if (!Number.isSafeInteger(maxDecodeQueue) || maxDecodeQueue <= 0 || maxDecodeQueue > 32) {
      fail('windows_native_decode_queue_invalid');
    }
    if (typeof chunkFactory !== 'function') fail('windows_native_chunk_factory_required');

    this.decoder = decoder;
    this.chunkFactory = chunkFactory;
    this.maxDecodeQueue = maxDecodeQueue;
    this.reassembler = new WindowsNativeMediaReassembler({ timeoutMs });
    this.nextTimestamp = 0;
  }

  reset() {
    this.reassembler.reset();
  }

  push(value, nowMs) {
    const frame = this.reassembler.push(value, nowMs);
    if (!frame) return false;

    const queueSize = Number(this.decoder.decodeQueueSize ?? 0);
    if (!Number.isFinite(queueSize) || queueSize < 0 || queueSize >= this.maxDecodeQueue) {
      this.reassembler.reset();
      fail('windows_native_decode_queue_full');
    }

    const chunk = this.chunkFactory({
      type: frame.keyframe ? 'key' : 'delta',
      timestamp: this.nextTimestamp,
      data: frame.bytes,
    });
    this.nextTimestamp += 1;
    this.decoder.decode(chunk);
    return true;
  }
}


function hexByte(value) {
  return value.toString(16).padStart(2, '0');
}

/**
 * Derive the fully-qualified AVC codec string from the first SPS NAL in an
 * Annex-B H.264 access unit. NVENC start/reconnect frames carry SPS/PPS with
 * the forced IDR, so the browser never guesses profile/constraints/level.
 */
export function deriveAvcCodecFromAnnexB(value) {
  const bytes = asUint8Array(value);
  for (let index = 0; index + 4 < bytes.length; index += 1) {
    let nal = -1;
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      nal = index + 3;
    } else if (
      index + 4 < bytes.length &&
      bytes[index] === 0 &&
      bytes[index + 1] === 0 &&
      bytes[index + 2] === 0 &&
      bytes[index + 3] === 1
    ) {
      nal = index + 4;
    }
    if (nal < 0 || nal + 3 >= bytes.length) continue;
    if ((bytes[nal] & 0x1f) !== 7) continue;
    return `avc1.${hexByte(bytes[nal + 1])}${hexByte(bytes[nal + 2])}${hexByte(bytes[nal + 3])}`;
  }
  fail('windows_native_h264_sps_required');
}

export class CanvasVideoFrameRenderer {
  constructor({ canvas, onRendered = () => {} }) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      fail('windows_native_canvas_required');
    }
    if (typeof onRendered !== 'function') fail('windows_native_render_callback');
    const context = canvas.getContext('2d', { alpha: false });
    if (!context || typeof context.drawImage !== 'function') {
      fail('windows_native_canvas_context');
    }
    this.canvas = canvas;
    this.context = context;
    this.onRendered = onRendered;
    this.renderedFrames = 0;
  }

  render(frame, metadata) {
    if (!frame || typeof frame.close !== 'function') {
      fail('windows_native_video_frame_required');
    }
    try {
      const width = Number(frame.displayWidth ?? frame.codedWidth ?? 0);
      const height = Number(frame.displayHeight ?? frame.codedHeight ?? 0);
      if (
        width !== metadata.width ||
        height !== metadata.height ||
        width < 640 ||
        width > 7680 ||
        height < 480 ||
        height > 4320
      ) {
        fail('windows_native_video_frame_dimensions');
      }
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this.context.drawImage(frame, 0, 0, width, height);
      this.renderedFrames += 1;
      this.onRendered({
        ...metadata,
        renderedFrames: this.renderedFrames,
      });
    } finally {
      frame.close();
    }
  }
}

/**
 * Browser-ready WebCodecs pipeline:
 * wire packet -> bounded reassembly -> SPS-derived decoder configuration ->
 * EncodedVideoChunk -> VideoDecoder -> caller-owned renderer.
 *
 * push() is async because decoder support is checked on every new stream epoch.
 * Callers should serialize push() calls; WindowsNativeDesktopClient does this.
 */
export class WindowsNativeWebCodecsSession {
  constructor({
    output,
    onError = () => {},
    decoderFactory = (init) => {
      if (typeof globalThis.VideoDecoder !== 'function') {
        fail('windows_native_webcodecs_unavailable');
      }
      return new globalThis.VideoDecoder(init);
    },
    configProbe = async (config) => {
      if (typeof globalThis.VideoDecoder?.isConfigSupported !== 'function') {
        fail('windows_native_webcodecs_unavailable');
      }
      return globalThis.VideoDecoder.isConfigSupported(config);
    },
    chunkFactory = (init) => {
      if (typeof globalThis.EncodedVideoChunk !== 'function') {
        fail('windows_native_webcodecs_unavailable');
      }
      return new globalThis.EncodedVideoChunk(init);
    },
    maxDecodeQueue = 4,
    timeoutMs = BROWSER_MEDIA_REASSEMBLY_TIMEOUT_MS,
  }) {
    if (typeof output !== 'function') fail('windows_native_decoder_output_required');
    if (typeof onError !== 'function') fail('windows_native_decoder_error_callback');
    if (typeof decoderFactory !== 'function' || typeof configProbe !== 'function') {
      fail('windows_native_decoder_factory');
    }
    if (typeof chunkFactory !== 'function') fail('windows_native_chunk_factory_required');
    if (!Number.isSafeInteger(maxDecodeQueue) || maxDecodeQueue <= 0 || maxDecodeQueue > 32) {
      fail('windows_native_decode_queue_invalid');
    }

    this.output = output;
    this.onError = onError;
    this.decoderFactory = decoderFactory;
    this.configProbe = configProbe;
    this.chunkFactory = chunkFactory;
    this.maxDecodeQueue = maxDecodeQueue;
    this.reassembler = new WindowsNativeMediaReassembler({ timeoutMs });
    this.decoder = null;
    this.streamEpoch = null;
    this.codec = null;
    this.nextTimestamp = 1;
    this.pendingMetadata = new Map();
  }

  #decoderError(error) {
    this.reassembler.reset();
    this.pendingMetadata.clear();
    this.onError(error instanceof Error ? error : new Error('windows_native_decoder_failed'));
  }

  #closeDecoder() {
    if (!this.decoder) return;
    try {
      if (this.decoder.state !== 'closed' && typeof this.decoder.close === 'function') {
        this.decoder.close();
      }
    } catch {
      // Closing is a best-effort resource release; state is cleared below.
    }
    this.decoder = null;
    this.pendingMetadata.clear();
  }

  close() {
    this.#closeDecoder();
    this.reassembler.reset();
    this.streamEpoch = null;
    this.codec = null;
  }

  async #configureForFrame(frame) {
    if (!frame.keyframe) fail('windows_native_media_keyframe_required');
    const codec = deriveAvcCodecFromAnnexB(frame.bytes);
    const config = {
      codec,
      codedWidth: frame.width,
      codedHeight: frame.height,
      optimizeForLatency: true,
    };
    const support = await this.configProbe(config);
    if (!support || support.supported !== true) {
      fail('windows_native_webcodecs_config_unsupported');
    }

    this.#closeDecoder();
    const decoder = this.decoderFactory({
      output: (videoFrame) => {
        const timestamp = Number(videoFrame?.timestamp);
        const metadata = this.pendingMetadata.get(timestamp);
        if (!metadata) {
          try { videoFrame?.close?.(); } catch {}
          this.#decoderError(new Error('windows_native_decoder_output_unbound'));
          return;
        }
        this.pendingMetadata.delete(timestamp);
        try {
          this.output(videoFrame, metadata);
        } catch (error) {
          this.#decoderError(error);
        }
      },
      error: (error) => this.#decoderError(error),
    });
    if (!decoder || typeof decoder.configure !== 'function' || typeof decoder.decode !== 'function') {
      fail('windows_native_decoder_required');
    }
    decoder.configure(config);
    this.decoder = decoder;
    this.streamEpoch = frame.streamEpoch;
    this.codec = codec;
  }

  async push(value, nowMs) {
    const frame = this.reassembler.push(value, nowMs);
    if (!frame) return false;

    if (this.streamEpoch !== frame.streamEpoch) {
      await this.#configureForFrame(frame);
    }
    if (!this.decoder || this.decoder.state === 'closed') {
      this.reassembler.reset();
      fail('windows_native_decoder_not_ready');
    }

    const queueSize = Number(this.decoder.decodeQueueSize ?? 0);
    if (!Number.isFinite(queueSize) || queueSize < 0 || queueSize >= this.maxDecodeQueue) {
      this.reassembler.reset();
      fail('windows_native_decode_queue_full');
    }

    const timestamp = this.nextTimestamp;
    this.nextTimestamp += 1;
    const metadata = {
      streamEpoch: frame.streamEpoch,
      frameSequence: frame.frameSequence,
      width: frame.width,
      height: frame.height,
      keyframe: frame.keyframe,
      timestamp,
      codec: this.codec,
    };
    this.pendingMetadata.set(timestamp, metadata);
    try {
      const chunk = this.chunkFactory({
        type: frame.keyframe ? 'key' : 'delta',
        timestamp,
        data: frame.bytes,
      });
      this.decoder.decode(chunk);
    } catch (error) {
      this.pendingMetadata.delete(timestamp);
      this.reassembler.reset();
      throw error;
    }
    return true;
  }
}
