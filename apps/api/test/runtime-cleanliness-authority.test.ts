import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalRuntimeSessionIds, runtimeExpectationMatches } from '../src/runtime-cleanliness-authority.js';

test('runtime authority snapshot matches regardless of ordering', () => {
  assert.equal(runtimeExpectationMatches(['session-b', 'session-a'], ['session-a', 'session-b']), true);
});

test('runtime authority snapshot rejects a session that ended during the diagnostic', () => {
  assert.equal(runtimeExpectationMatches(['session-a', 'session-b'], ['session-a']), false);
});

test('runtime authority snapshot rejects a session that started during the diagnostic', () => {
  assert.equal(runtimeExpectationMatches(['session-a'], ['session-a', 'session-b']), false);
});

test('runtime authority canonicalization is deterministic and de-duplicates ids', () => {
  assert.deepEqual(canonicalRuntimeSessionIds(['b', 'a', 'b', '']), ['a', 'b']);
});
