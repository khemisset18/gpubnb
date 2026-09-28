import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_INPUT_FLAG_EXTENDED,
  BROWSER_INPUT_FLAG_KEY_UP,
  BROWSER_INPUT_FRAME_SIZE,
  BROWSER_INPUT_KIND_KEY,
  BROWSER_INPUT_KIND_MOUSE_ABSOLUTE,
  BROWSER_INPUT_KIND_MOUSE_BUTTON,
  BROWSER_INPUT_KIND_MOUSE_RELATIVE,
  BROWSER_INPUT_KIND_MOUSE_WHEEL,
  BROWSER_INPUT_PROTOCOL_VERSION,
  WindowsNativeInputEncoder,
  encodeWindowsNativeInput,
  normalizePointerCoordinate,
  windowsScanCode,
} from './windows-native-input.js';

function decode(bytes) {
  assert.equal(bytes.byteLength, BROWSER_INPUT_FRAME_SIZE);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x47, 0x42, 0x4e, 0x49]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint16(4, true),
    kind: view.getUint8(6),
    flags: view.getUint8(7),
    epoch: view.getBigUint64(8, true),
    sequence: view.getBigUint64(16, true),
    a: view.getInt32(24, true),
    b: view.getInt32(28, true),
  };
}

test('encodes a fixed-size fenced key input frame', () => {
  const bytes = encodeWindowsNativeInput({
    streamEpoch: 7n,
    sequence: 9n,
    kind: BROWSER_INPUT_KIND_KEY,
    flags: BROWSER_INPUT_FLAG_KEY_UP | BROWSER_INPUT_FLAG_EXTENDED,
    a: 0x1d,
  });
  assert.deepEqual(decode(bytes), {
    version: BROWSER_INPUT_PROTOCOL_VERSION,
    kind: BROWSER_INPUT_KIND_KEY,
    flags: BROWSER_INPUT_FLAG_KEY_UP | BROWSER_INPUT_FLAG_EXTENDED,
    epoch: 7n,
    sequence: 9n,
    a: 0x1d,
    b: 0,
  });
});

test('maps only an explicit browser-code allowlist to Windows scan codes', () => {
  assert.deepEqual(windowsScanCode('KeyA'), { scanCode: 0x1e, extended: false });
  assert.deepEqual(windowsScanCode('ArrowLeft'), { scanCode: 0x4b, extended: true });
  assert.deepEqual(windowsScanCode('ControlRight'), { scanCode: 0x1d, extended: true });
  assert.equal(windowsScanCode('Unidentified'), null);
  assert.equal(windowsScanCode('LaunchMail'), null);
});

test('absolute pointer normalization is bounded and deterministic', () => {
  assert.equal(normalizePointerCoordinate(0, 1920), 0);
  assert.equal(normalizePointerCoordinate(1919, 1920), 65_535);
  assert.equal(normalizePointerCoordinate(-50, 1920), 0);
  assert.equal(normalizePointerCoordinate(9000, 1920), 65_535);
  assert.throws(() => normalizePointerCoordinate(5, 1), /windows_native_input_pointer_geometry/);
});

test('input encoder sequences keyboard mouse button movement and wheel frames', () => {
  const sent = [];
  const encoder = new WindowsNativeInputEncoder({
    streamEpoch: 11n,
    send: (frame) => sent.push(decode(frame)),
  });

  assert.equal(encoder.key('KeyA'), true);
  assert.equal(encoder.key('KeyA', true), true);
  assert.equal(encoder.mouseRelative(3.8, -2.2), true);
  assert.equal(encoder.mouseAbsolute(100, 50, 200, 100), true);
  assert.equal(encoder.mouseButton(0), true);
  assert.equal(encoder.mouseButton(0, true), true);
  assert.equal(encoder.mouseWheel(120), true);

  assert.deepEqual(sent.map((item) => item.sequence), [1n, 2n, 3n, 4n, 5n, 6n, 7n]);
  assert.equal(sent[0].kind, BROWSER_INPUT_KIND_KEY);
  assert.equal(sent[1].flags, BROWSER_INPUT_FLAG_KEY_UP);
  assert.deepEqual([sent[2].kind, sent[2].a, sent[2].b], [BROWSER_INPUT_KIND_MOUSE_RELATIVE, 3, -2]);
  assert.equal(sent[3].kind, BROWSER_INPUT_KIND_MOUSE_ABSOLUTE);
  assert.equal(sent[4].kind, BROWSER_INPUT_KIND_MOUSE_BUTTON);
  assert.equal(sent[5].flags, BROWSER_INPUT_FLAG_KEY_UP);
  assert.equal(sent[6].kind, BROWSER_INPUT_KIND_MOUSE_WHEEL);
});

test('unsupported or empty browser events are not emitted', () => {
  const sent = [];
  const encoder = new WindowsNativeInputEncoder({
    streamEpoch: 1n,
    send: (frame) => sent.push(frame),
  });

  assert.equal(encoder.key('Unidentified'), false);
  assert.equal(encoder.mouseRelative(0, 0), false);
  assert.equal(encoder.mouseButton(9), false);
  assert.equal(encoder.mouseWheel(0), false);
  assert.equal(sent.length, 0);
});

test('malformed protocol values fail before bytes are emitted', () => {
  const base = {
    streamEpoch: 1n,
    sequence: 1n,
    kind: BROWSER_INPUT_KIND_KEY,
    a: 0x1e,
  };
  assert.throws(
    () => encodeWindowsNativeInput({ ...base, streamEpoch: 0n }),
    /windows_native_input_epoch/,
  );
  assert.throws(
    () => encodeWindowsNativeInput({ ...base, sequence: 0n }),
    /windows_native_input_sequence/,
  );
  assert.throws(
    () => encodeWindowsNativeInput({ ...base, flags: 0x80 }),
    /windows_native_input_key/,
  );
  assert.throws(
    () => encodeWindowsNativeInput({
      ...base,
      kind: BROWSER_INPUT_KIND_MOUSE_RELATIVE,
      a: 40_000,
      b: 1,
    }),
    /windows_native_input_mouse_delta/,
  );
  assert.throws(
    () => encodeWindowsNativeInput({
      ...base,
      kind: BROWSER_INPUT_KIND_MOUSE_WHEEL,
      a: 1_201,
    }),
    /windows_native_input_mouse_wheel/,
  );
});
