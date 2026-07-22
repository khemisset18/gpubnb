import assert from 'node:assert/strict';
import test from 'node:test';
import { validCsrfToken } from '../src/security.js';

test('CSRF token comparison accepts only the complete session-bound token', () => {
  const token = 'a'.repeat(43);
  assert.equal(validCsrfToken(token, token), true);
  assert.equal(validCsrfToken(undefined, token), false);
  assert.equal(validCsrfToken('a'.repeat(42), token), false);
  assert.equal(validCsrfToken(`${'a'.repeat(42)}b`, token), false);
});
