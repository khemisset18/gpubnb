import test from 'node:test';
import assert from 'node:assert/strict';
import { escrowExpiryUnix } from '../src/booking.js';

test('escrow expires one hour after the reservation ends', () => {
  assert.equal(escrowExpiryUnix(new Date('2026-07-22T12:00:00Z')), 1_784_725_200n);
});

test('escrow expiry rejects invalid dates', () => {
  assert.throws(() => escrowExpiryUnix(new Date('invalid')), /invalid booking end/);
});
