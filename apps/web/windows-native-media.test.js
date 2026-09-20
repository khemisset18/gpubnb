import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_MEDIA_FLAG_KEYFRAME,
  BROWSER_MEDIA_HEADER_SIZE,
  BROWSER_MEDIA_PROTOCOL_VERSION,
  BROWSER_MEDIA_CODEC_H264,
  WindowsNativeMediaReassembler,
  BoundedWebCodecsH264Consumer,
} from './windows-native-media.js';

function packet({
  epoch = 1n,
  sequence = 1n,
  width = 1920,
  height = 1080,
  frameBytes,
  offset = 0,
  keyframe = false,
  payload,
}) {
  const bytes = new Uint8Array(BROWSER_MEDIA_HEADER_SIZE + payload.length);
  bytes.set([0x47, 0x42, 0x4e, 0x4d], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, BROWSER_MEDIA_PROTOCOL_VERSION, true);
  view.setUint8(6, BROWSER_MEDIA_CODEC_H264);
  view.setUint8(7, keyframe ? BROWSER_MEDIA_FLAG_KEYFRAME : 0);
  view.setBigUint64(8, epoch, true);
  view.setBigUint64(16, sequence, true);
  view.setUint32(24, width, true);
  view.setUint32(28, height, true);
  view.setUint32(32, frameBytes, true);
  view.setUint32(36, offset, true);
  view.setUint32(40, payload.length, true);
  bytes.set(payload, BROWSER_MEDIA_HEADER_SIZE);
  return bytes;
}

test('reassembles only a complete contiguous keyframe', () => {
  const reassembler = new WindowsNativeMediaReassembler({ timeoutMs: 1000 });
  assert.equal(
    reassembler.push(
      packet({ frameBytes: 6, offset: 0, keyframe: true, payload: Uint8Array.from([1, 2, 3]) }),
      10,
    ),
    null,
  );

  const frame = reassembler.push(
    packet({ frameBytes: 6, offset: 3, keyframe: true, payload: Uint8Array.from([4, 5, 6]) }),
    20,
  );
  assert.equal(frame.streamEpoch, 1n);
  assert.equal(frame.frameSequence, 1n);
  assert.equal(frame.keyframe, true);
  assert.deepEqual([...frame.bytes], [1, 2, 3, 4, 5, 6]);
});

test('duplicate or gapped chunks discard partial bytes and require a fresh keyframe', () => {
  const reassembler = new WindowsNativeMediaReassembler();
  const first = packet({
    frameBytes: 6,
    offset: 0,
    keyframe: true,
    payload: Uint8Array.from([1, 2, 3]),
  });
  assert.equal(reassembler.push(first, 1), null);
  assert.throws(() => reassembler.push(first, 2), /windows_native_media_frame_order/);

  assert.throws(
    () =>
      reassembler.push(
        packet({
          sequence: 2n,
          frameBytes: 3,
          keyframe: false,
          payload: Uint8Array.from([7, 8, 9]),
        }),
        3,
      ),
    /windows_native_media_keyframe_required/,
  );

  const recovered = reassembler.push(
    packet({
      sequence: 2n,
      frameBytes: 3,
      keyframe: true,
      payload: Uint8Array.from([7, 8, 9]),
    }),
    4,
  );
  assert.deepEqual([...recovered.bytes], [7, 8, 9]);
});

test('a newer epoch invalidates an incomplete old frame and starts only from a keyframe', () => {
  const reassembler = new WindowsNativeMediaReassembler();
  assert.equal(
    reassembler.push(
      packet({
        epoch: 7n,
        sequence: 9n,
        frameBytes: 6,
        keyframe: true,
        payload: Uint8Array.from([1, 2, 3]),
      }),
      1,
    ),
    null,
  );

  assert.throws(
    () =>
      reassembler.push(
        packet({
          epoch: 8n,
          sequence: 1n,
          frameBytes: 3,
          keyframe: false,
          payload: Uint8Array.from([4, 5, 6]),
        }),
        2,
      ),
    /windows_native_media_frame_order/,
  );

  const frame = reassembler.push(
    packet({
      epoch: 8n,
      sequence: 1n,
      frameBytes: 3,
      keyframe: true,
      payload: Uint8Array.from([4, 5, 6]),
    }),
    3,
  );
  assert.equal(frame.streamEpoch, 8n);
  assert.deepEqual([...frame.bytes], [4, 5, 6]);
});

test('an incomplete frame times out and is never emitted', () => {
  const reassembler = new WindowsNativeMediaReassembler({ timeoutMs: 50 });
  assert.equal(
    reassembler.push(
      packet({
        frameBytes: 6,
        keyframe: true,
        payload: Uint8Array.from([1, 2, 3]),
      }),
      10,
    ),
    null,
  );

  assert.throws(
    () =>
      reassembler.push(
        packet({
          frameBytes: 6,
          offset: 3,
          keyframe: true,
          payload: Uint8Array.from([4, 5, 6]),
        }),
        61,
      ),
    /windows_native_media_timeout/,
  );
});

test('WebCodecs consumer decodes only complete frames and enforces bounded backpressure', () => {
  const decoded = [];
  const decoder = {
    decodeQueueSize: 0,
    decode(chunk) {
      decoded.push(chunk);
    },
  };
  const consumer = new BoundedWebCodecsH264Consumer({
    decoder,
    maxDecodeQueue: 2,
    chunkFactory: (init) => init,
  });

  assert.equal(
    consumer.push(
      packet({
        frameBytes: 6,
        keyframe: true,
        payload: Uint8Array.from([1, 2, 3]),
      }),
      1,
    ),
    false,
  );
  assert.equal(decoded.length, 0);

  assert.equal(
    consumer.push(
      packet({
        frameBytes: 6,
        offset: 3,
        keyframe: true,
        payload: Uint8Array.from([4, 5, 6]),
      }),
      2,
    ),
    true,
  );
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].type, 'key');
  assert.deepEqual([...decoded[0].data], [1, 2, 3, 4, 5, 6]);

  decoder.decodeQueueSize = 2;
  assert.throws(
    () =>
      consumer.push(
        packet({
          sequence: 2n,
          frameBytes: 3,
          keyframe: false,
          payload: Uint8Array.from([7, 8, 9]),
        }),
        3,
      ),
    /windows_native_decode_queue_full/,
  );

  decoder.decodeQueueSize = 0;
  assert.throws(
    () =>
      consumer.push(
        packet({
          sequence: 3n,
          frameBytes: 3,
          keyframe: false,
          payload: Uint8Array.from([10, 11, 12]),
        }),
        4,
      ),
    /windows_native_media_keyframe_required/,
  );
});
