import test from 'node:test';
import assert from 'node:assert/strict';
import { publicClientError } from '../src/http-errors.js';

test('preserves Fastify rate-limit errors as HTTP 429', () => {
  assert.deepEqual(publicClientError({ statusCode: 429 }), { statusCode: 429, code: 'rate_limited' });
});

test('preserves other client errors without leaking their message', () => {
  assert.deepEqual(publicClientError({ statusCode: 404, message: 'sensitive detail' }), { statusCode: 404, code: 'request_error' });
});

test('keeps server and malformed errors on the internal-error path', () => {
  assert.equal(publicClientError({ statusCode: 500 }), null);
  assert.equal(publicClientError(new Error('boom')), null);
  assert.equal(publicClientError({ statusCode: '429' }), null);
});
