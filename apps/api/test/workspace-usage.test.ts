import test from 'node:test';
import assert from 'node:assert/strict';
import { validatedUsageIncrement } from '../src/workspace-usage.js';

test('counts only available intervals backed by a workload proof', () => {
  assert.equal(validatedUsageIncrement(10, 100, 5, true, true), 5);
  assert.equal(validatedUsageIncrement(10, 100, 5, false, true), 0);
  assert.equal(validatedUsageIncrement(10, 100, 5, true, false), 0);
});

test('never validates more usage than the booking duration', () => {
  assert.equal(validatedUsageIncrement(98, 100, 5, true, true), 2);
  assert.equal(validatedUsageIncrement(100, 100, 5, true, true), 0);
});
