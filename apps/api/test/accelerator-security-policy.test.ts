import assert from 'node:assert/strict';
import test from 'node:test';
import { decideAcceleratorSecurity } from '../src/accelerator-security-policy.js';

const clean = { added: 0, updated: 1, removed: 0, securityChanges: 0 };
const baseContext = {
  hasBoundSession: false,
  sessionIsActive: false,
  primaryAcceleratorAvailable: true,
  legacyGpuMatches: true,
};

test('keeps a stable machine publishable', () => {
  assert.deepEqual(decideAcceleratorSecurity(clean, baseContext), {
    severity: 'NONE',
    publishable: true,
    freezeSession: false,
    reason: 'NO_CHANGE',
  });
});

test('requires verification when inventory changes outside a session', () => {
  const decision = decideAcceleratorSecurity(
    { added: 1, updated: 0, removed: 0, securityChanges: 0 },
    baseContext,
  );
  assert.equal(decision.severity, 'VERIFY');
  assert.equal(decision.publishable, false);
  assert.equal(decision.freezeSession, false);
});

test('quarantines and freezes on removal during an active bound session', () => {
  const decision = decideAcceleratorSecurity(
    { added: 0, updated: 0, removed: 1, securityChanges: 0 },
    { ...baseContext, hasBoundSession: true, sessionIsActive: true },
  );
  assert.deepEqual(decision, {
    severity: 'QUARANTINE',
    publishable: false,
    freezeSession: true,
    reason: 'CRITICAL_CHANGE_DURING_SESSION',
  });
});

test('quarantines an identity mutation during an active session', () => {
  const decision = decideAcceleratorSecurity(
    { added: 0, updated: 1, removed: 0, securityChanges: 1 },
    { ...baseContext, hasBoundSession: true, sessionIsActive: true },
  );
  assert.equal(decision.severity, 'QUARANTINE');
  assert.equal(decision.freezeSession, true);
});

test('does not quarantine a missing accelerator outside a session', () => {
  const decision = decideAcceleratorSecurity(clean, {
    ...baseContext,
    primaryAcceleratorAvailable: false,
  });
  assert.deepEqual(decision, {
    severity: 'VERIFY',
    publishable: false,
    freezeSession: false,
    reason: 'PRIMARY_ACCELERATOR_UNAVAILABLE',
  });
});

test('treats a legacy GPU mismatch as verification outside a session', () => {
  const decision = decideAcceleratorSecurity(clean, {
    ...baseContext,
    legacyGpuMatches: false,
  });
  assert.equal(decision.severity, 'VERIFY');
  assert.equal(decision.reason, 'LEGACY_GPU_MISMATCH');
});
