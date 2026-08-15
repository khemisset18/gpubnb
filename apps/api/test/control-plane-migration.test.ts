import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeMigrationPlan,
  controlPlaneMigrationPlan,
} from '../src/control-plane-migration.js';

test('shadow mode dual-writes but never becomes read authority', () => {
  assert.deepEqual(controlPlaneMigrationPlan('shadow'), {
    mode: 'shadow',
    writeLegacyRuntime: true,
    writeHotPresence: true,
    presenceReadAuthority: 'LEGACY_DATABASE',
    legacyPollingFallbackAllowed: true,
  });
});

test('hot mode is an explicit authority cutover', () => {
  assert.deepEqual(controlPlaneMigrationPlan('hot'), {
    mode: 'hot',
    writeLegacyRuntime: false,
    writeHotPresence: true,
    presenceReadAuthority: 'HOT_REDIS',
    legacyPollingFallbackAllowed: true,
  });
});

test('unsafe shadow plans fail closed', () => {
  assert.throws(
    () => assertSafeMigrationPlan({
      mode: 'shadow',
      writeLegacyRuntime: true,
      writeHotPresence: true,
      presenceReadAuthority: 'HOT_REDIS',
      legacyPollingFallbackAllowed: true,
    }),
    /shadow_presence_plan_unsafe/,
  );
});
