'use strict';

// This is a keyboard/mouse compatibility bridge, NOT an XInput device. It
// deliberately reuses the existing epoch-fenced browser input protocol;
// unknown controllers never send unvalidated native commands.
const DEADZONE = 0.38;
const MAX_POINTER_STEP = 14;
const AIM_INTERVAL_MS = 1000 / 60;
const BUTTON_KEYS = Object.freeze([
  [0, 'Space'],       // A: jump / confirm
  [1, 'Escape'],      // B: back
  [2, 'KeyE'],        // X: interact
  [3, 'KeyR'],        // Y: reload
  [4, 'ShiftLeft'],  // LB: sprint
  [5, 'ControlLeft'],// RB: crouch
  [8, 'Tab'],         // Back: menu
  [9, 'Escape'],      // Start: pause
  [10, 'KeyF'],      // L3
  [11, 'KeyC'],      // R3
]);

function axis(value) {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function pressed(value) {
  return value?.pressed === true ||
    (Number.isFinite(value?.value) && value.value >= 0.5);
}

function standardGamepad(pads) {
  if (!pads || typeof pads[Symbol.iterator] !== 'function') return null;
  for (const pad of pads) {
    if (pad?.connected === true && pad.mapping === 'standard' &&
        pad.buttons?.length >= 16 && pad.axes?.length >= 4) return pad;
  }
  return null;
}

function desiredKeys(pad) {
  const keys = new Set();
  for (const [index, code] of BUTTON_KEYS) {
    if (pressed(pad.buttons[index])) keys.add(code);
  }
  // Left stick and D-pad use the ordinary Windows keyboard path. This works
  // with games supporting keyboard/mouse, without claiming virtual XInput.
  if (axis(pad.axes[1]) < -DEADZONE || pressed(pad.buttons[12])) keys.add('KeyW');
  if (axis(pad.axes[1]) > DEADZONE || pressed(pad.buttons[13])) keys.add('KeyS');
  if (axis(pad.axes[0]) < -DEADZONE || pressed(pad.buttons[14])) keys.add('KeyA');
  if (axis(pad.axes[0]) > DEADZONE || pressed(pad.buttons[15])) keys.add('KeyD');
  return keys;
}

export class WindowsNativeGamepadBridge {
  constructor({ key, pointerButton, mouseRelative }) {
    if (typeof key !== 'function' || typeof pointerButton !== 'function' ||
        typeof mouseRelative !== 'function') {
      throw new Error('windows_native_gamepad_callbacks_required');
    }
    this.key = key;
    this.pointerButton = pointerButton;
    this.mouseRelative = mouseRelative;
    this.heldKeys = new Set();
    this.triggerHeld = false;
    this.nextAimAt = null;
    this.lastAimPollAt = null;
    this.controllerIdentity = null;
  }

  update(gamepads, timestamp = globalThis.performance?.now?.() ?? Date.now()) {
    const pad = standardGamepad(gamepads);
    if (!pad) {
      this.release();
      return false;
    }
    const identity = Number.isSafeInteger(pad.index) && pad.index >= 0
      ? JSON.stringify([pad.index, typeof pad.id === 'string' ? pad.id : ''])
      : null;
    if (this.controllerIdentity !== identity) {
      this.release();
      this.controllerIdentity = identity;
    }
    const next = desiredKeys(pad);
    for (const code of [...this.heldKeys]) {
      if (!next.has(code)) {
        // Keep ownership until the current input transport accepts the up.
        // On an exception the viewer disarms and releases all wire inputs.
        if (this.key(code, true)) this.heldKeys.delete(code);
      }
    }
    for (const code of next) {
      if (!this.heldKeys.has(code) && this.key(code, false)) this.heldKeys.add(code);
    }
    const trigger = pressed(pad.buttons[7]);
    if (trigger !== this.triggerHeld && this.pointerButton(0, !trigger)) {
      this.triggerHeld = trigger;
    }
    const x = axis(pad.axes[2]);
    const y = axis(pad.axes[3]);
    const dx = Math.abs(x) > DEADZONE ? Math.round(x * MAX_POINTER_STEP) : 0;
    const dy = Math.abs(y) > DEADZONE ? Math.round(y * MAX_POINTER_STEP) : 0;
    // requestAnimationFrame may run at 60, 120, 144 or 240 Hz. Keep aiming
    // near the same 60-Hz event cadence, with no catch-up burst after a stall.
    // Key and button changes above still run on every available poll.
    if (!Number.isFinite(timestamp) || timestamp < 0) return true;
    if (this.lastAimPollAt !== null && timestamp < this.lastAimPollAt) {
      this.nextAimAt = timestamp + AIM_INTERVAL_MS;
    }
    this.lastAimPollAt = timestamp;
    if (this.nextAimAt === null || timestamp + 0.0001 >= this.nextAimAt) {
      const previousDeadline = this.nextAimAt;
      this.nextAimAt = previousDeadline === null || timestamp - previousDeadline >= AIM_INTERVAL_MS
        ? timestamp + AIM_INTERVAL_MS
        : previousDeadline + AIM_INTERVAL_MS;
      if (dx || dy) this.mouseRelative(dx, dy);
    }
    return true;
  }

  release() {
    for (const code of [...this.heldKeys]) {
      try { this.key(code, true); } catch {} // Transport may already be revoked.
    }
    this.heldKeys.clear();
    this.nextAimAt = null;
    this.lastAimPollAt = null;
    this.controllerIdentity = null;
    if (this.triggerHeld) {
      try { this.pointerButton(0, true); } catch {}
      this.triggerHeld = false;
    }
  }
}
