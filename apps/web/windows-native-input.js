'use strict';

export const BROWSER_INPUT_PROTOCOL_VERSION = 1;
export const BROWSER_INPUT_FRAME_SIZE = 32;

export const BROWSER_INPUT_KIND_KEY = 1;
export const BROWSER_INPUT_KIND_MOUSE_RELATIVE = 2;
export const BROWSER_INPUT_KIND_MOUSE_ABSOLUTE = 3;
export const BROWSER_INPUT_KIND_MOUSE_BUTTON = 4;
export const BROWSER_INPUT_KIND_MOUSE_WHEEL = 5;

export const BROWSER_INPUT_FLAG_KEY_UP = 0x01;
export const BROWSER_INPUT_FLAG_EXTENDED = 0x02;

const MAGIC = [0x47, 0x42, 0x4e, 0x49]; // GBNI
const MAX_RELATIVE_DELTA = 32_767;
const MAX_WHEEL_DELTA = 1_200;

const SCAN_CODES = new Map([
  ['Escape',[0x01,false]],
  ['Digit1',[0x02,false]],['Digit2',[0x03,false]],['Digit3',[0x04,false]],['Digit4',[0x05,false]],
  ['Digit5',[0x06,false]],['Digit6',[0x07,false]],['Digit7',[0x08,false]],['Digit8',[0x09,false]],
  ['Digit9',[0x0a,false]],['Digit0',[0x0b,false]],['Minus',[0x0c,false]],['Equal',[0x0d,false]],
  ['Backspace',[0x0e,false]],['Tab',[0x0f,false]],
  ['KeyQ',[0x10,false]],['KeyW',[0x11,false]],['KeyE',[0x12,false]],['KeyR',[0x13,false]],
  ['KeyT',[0x14,false]],['KeyY',[0x15,false]],['KeyU',[0x16,false]],['KeyI',[0x17,false]],
  ['KeyO',[0x18,false]],['KeyP',[0x19,false]],['BracketLeft',[0x1a,false]],['BracketRight',[0x1b,false]],
  ['Enter',[0x1c,false]],['ControlLeft',[0x1d,false]],
  ['KeyA',[0x1e,false]],['KeyS',[0x1f,false]],['KeyD',[0x20,false]],['KeyF',[0x21,false]],
  ['KeyG',[0x22,false]],['KeyH',[0x23,false]],['KeyJ',[0x24,false]],['KeyK',[0x25,false]],
  ['KeyL',[0x26,false]],['Semicolon',[0x27,false]],['Quote',[0x28,false]],['Backquote',[0x29,false]],
  ['ShiftLeft',[0x2a,false]],['Backslash',[0x2b,false]],
  ['KeyZ',[0x2c,false]],['KeyX',[0x2d,false]],['KeyC',[0x2e,false]],['KeyV',[0x2f,false]],
  ['KeyB',[0x30,false]],['KeyN',[0x31,false]],['KeyM',[0x32,false]],['Comma',[0x33,false]],
  ['Period',[0x34,false]],['Slash',[0x35,false]],['ShiftRight',[0x36,false]],
  ['NumpadMultiply',[0x37,false]],['AltLeft',[0x38,false]],['Space',[0x39,false]],['CapsLock',[0x3a,false]],
  ['F1',[0x3b,false]],['F2',[0x3c,false]],['F3',[0x3d,false]],['F4',[0x3e,false]],
  ['F5',[0x3f,false]],['F6',[0x40,false]],['F7',[0x41,false]],['F8',[0x42,false]],
  ['F9',[0x43,false]],['F10',[0x44,false]],['NumLock',[0x45,false]],['ScrollLock',[0x46,false]],
  ['Numpad7',[0x47,false]],['Numpad8',[0x48,false]],['Numpad9',[0x49,false]],['NumpadSubtract',[0x4a,false]],
  ['Numpad4',[0x4b,false]],['Numpad5',[0x4c,false]],['Numpad6',[0x4d,false]],['NumpadAdd',[0x4e,false]],
  ['Numpad1',[0x4f,false]],['Numpad2',[0x50,false]],['Numpad3',[0x51,false]],['Numpad0',[0x52,false]],
  ['NumpadDecimal',[0x53,false]],['F11',[0x57,false]],['F12',[0x58,false]],
  ['ControlRight',[0x1d,true]],['AltRight',[0x38,true]],['NumpadEnter',[0x1c,true]],
  ['NumpadDivide',[0x35,true]],['Home',[0x47,true]],['ArrowUp',[0x48,true]],['PageUp',[0x49,true]],
  ['ArrowLeft',[0x4b,true]],['ArrowRight',[0x4d,true]],['End',[0x4f,true]],['ArrowDown',[0x50,true]],
  ['PageDown',[0x51,true]],['Insert',[0x52,true]],['Delete',[0x53,true]],
  ['MetaLeft',[0x5b,true]],['MetaRight',[0x5c,true]],['ContextMenu',[0x5d,true]],
]);

const BUTTONS = new Map([[0,1],[2,2],[1,3],[3,4],[4,5]]);

function fail(code) {
  throw new Error(code);
}

function safeEpoch(value) {
  if (typeof value !== 'bigint' || value <= 0n || value > 0xffff_ffff_ffff_ffffn) {
    fail('windows_native_input_epoch');
  }
  return value;
}

function safeSequence(value) {
  if (typeof value !== 'bigint' || value <= 0n || value > 0xffff_ffff_ffff_ffffn) {
    fail('windows_native_input_sequence');
  }
  return value;
}

function boundedI32(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

export function windowsScanCode(code) {
  if (typeof code !== 'string') return null;
  const mapping = SCAN_CODES.get(code);
  return mapping ? { scanCode: mapping[0], extended: mapping[1] } : null;
}

export function normalizePointerCoordinate(value, extent) {
  if (!Number.isFinite(value) || !Number.isFinite(extent) || extent <= 1) {
    fail('windows_native_input_pointer_geometry');
  }
  const clamped = Math.max(0, Math.min(extent - 1, value));
  return Math.round((clamped * 65_535) / (extent - 1));
}

export function encodeWindowsNativeInput({
  streamEpoch,
  sequence,
  kind,
  flags = 0,
  a = 0,
  b = 0,
}) {
  safeEpoch(streamEpoch);
  safeSequence(sequence);
  if (!Number.isInteger(kind) || kind < BROWSER_INPUT_KIND_KEY || kind > BROWSER_INPUT_KIND_MOUSE_WHEEL) {
    fail('windows_native_input_kind');
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) fail('windows_native_input_flags');

  switch (kind) {
    case BROWSER_INPUT_KIND_KEY:
      boundedI32(a, 1, 0x01ff, 'windows_native_input_scan_code');
      if (b !== 0 || (flags & ~(BROWSER_INPUT_FLAG_KEY_UP | BROWSER_INPUT_FLAG_EXTENDED)) !== 0) {
        fail('windows_native_input_key');
      }
      break;
    case BROWSER_INPUT_KIND_MOUSE_RELATIVE:
      boundedI32(a, -MAX_RELATIVE_DELTA, MAX_RELATIVE_DELTA, 'windows_native_input_mouse_delta');
      boundedI32(b, -MAX_RELATIVE_DELTA, MAX_RELATIVE_DELTA, 'windows_native_input_mouse_delta');
      if ((a === 0 && b === 0) || flags !== 0) fail('windows_native_input_mouse_relative');
      break;
    case BROWSER_INPUT_KIND_MOUSE_ABSOLUTE:
      boundedI32(a, 0, 65_535, 'windows_native_input_mouse_absolute');
      boundedI32(b, 0, 65_535, 'windows_native_input_mouse_absolute');
      if (flags !== 0) fail('windows_native_input_mouse_absolute');
      break;
    case BROWSER_INPUT_KIND_MOUSE_BUTTON:
      boundedI32(a, 1, 5, 'windows_native_input_mouse_button');
      if (b !== 0 || (flags & ~BROWSER_INPUT_FLAG_KEY_UP) !== 0) fail('windows_native_input_mouse_button');
      break;
    case BROWSER_INPUT_KIND_MOUSE_WHEEL:
      boundedI32(a, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA, 'windows_native_input_mouse_wheel');
      if (a === 0 || b !== 0 || flags !== 0) fail('windows_native_input_mouse_wheel');
      break;
    default:
      fail('windows_native_input_kind');
  }

  const bytes = new Uint8Array(BROWSER_INPUT_FRAME_SIZE);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, BROWSER_INPUT_PROTOCOL_VERSION, true);
  view.setUint8(6, kind);
  view.setUint8(7, flags);
  view.setBigUint64(8, streamEpoch, true);
  view.setBigUint64(16, sequence, true);
  view.setInt32(24, a, true);
  view.setInt32(28, b, true);
  return bytes;
}

export class WindowsNativeInputEncoder {
  constructor({ streamEpoch, send }) {
    this.streamEpoch = safeEpoch(streamEpoch);
    if (typeof send !== 'function') fail('windows_native_input_sender');
    this.send = send;
    this.nextSequence = 1n;
  }

  #emit(kind, flags, a, b = 0) {
    const frame = encodeWindowsNativeInput({
      streamEpoch: this.streamEpoch,
      sequence: this.nextSequence,
      kind,
      flags,
      a,
      b,
    });
    this.nextSequence += 1n;
    this.send(frame);
    return true;
  }

  key(code, keyUp = false) {
    const mapping = windowsScanCode(code);
    if (!mapping) return false;
    const flags =
      (keyUp ? BROWSER_INPUT_FLAG_KEY_UP : 0) |
      (mapping.extended ? BROWSER_INPUT_FLAG_EXTENDED : 0);
    return this.#emit(BROWSER_INPUT_KIND_KEY, flags, mapping.scanCode);
  }

  mouseRelative(dx, dy) {
    const x = boundedI32(Math.trunc(dx), -MAX_RELATIVE_DELTA, MAX_RELATIVE_DELTA, 'windows_native_input_mouse_delta');
    const y = boundedI32(Math.trunc(dy), -MAX_RELATIVE_DELTA, MAX_RELATIVE_DELTA, 'windows_native_input_mouse_delta');
    if (x === 0 && y === 0) return false;
    return this.#emit(BROWSER_INPUT_KIND_MOUSE_RELATIVE, 0, x, y);
  }

  mouseAbsolute(x, y, width, height) {
    return this.#emit(
      BROWSER_INPUT_KIND_MOUSE_ABSOLUTE,
      0,
      normalizePointerCoordinate(x, width),
      normalizePointerCoordinate(y, height),
    );
  }

  mouseButton(button, keyUp = false) {
    const mapped = BUTTONS.get(button);
    if (!mapped) return false;
    return this.#emit(
      BROWSER_INPUT_KIND_MOUSE_BUTTON,
      keyUp ? BROWSER_INPUT_FLAG_KEY_UP : 0,
      mapped,
    );
  }

  mouseWheel(delta) {
    if (!Number.isFinite(delta) || delta === 0) return false;
    const bounded = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, Math.trunc(delta)));
    return this.#emit(BROWSER_INPUT_KIND_MOUSE_WHEEL, 0, bounded);
  }
}
