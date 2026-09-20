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
