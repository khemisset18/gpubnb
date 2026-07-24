export type AcceleratorSyncSummary = {
  added: number;
  updated: number;
  removed: number;
  securityChanges: number;
};

export type AcceleratorSecurityContext = {
  hasBoundSession: boolean;
  sessionIsActive: boolean;
  primaryAcceleratorAvailable: boolean;
  legacyGpuMatches: boolean;
};

export type AcceleratorSecurityDecision = {
  severity: 'NONE' | 'VERIFY' | 'QUARANTINE';
  publishable: boolean;
  freezeSession: boolean;
  reason:
    | 'NO_CHANGE'
    | 'PRIMARY_ACCELERATOR_UNAVAILABLE'
    | 'LEGACY_GPU_MISMATCH'
    | 'INVENTORY_CHANGED'
    | 'CRITICAL_CHANGE_DURING_SESSION';
};

/**
 * Pure policy for interpreting a validated accelerator inventory update.
 *
 * The policy is intentionally conservative while a paid session is active:
 * replacement, removal or identity mutation of hardware freezes execution until
 * the owner and platform re-verify the machine. Outside a session, the machine
 * is moved back to verification without being permanently quarantined.
 */
export function decideAcceleratorSecurity(
  summary: AcceleratorSyncSummary,
  context: AcceleratorSecurityContext,
): AcceleratorSecurityDecision {
  const inventoryChanged = summary.added > 0 || summary.removed > 0 || summary.securityChanges > 0;
  const criticalIdentityChange = summary.removed > 0 || summary.securityChanges > 0;
  const activeBoundSession = context.hasBoundSession && context.sessionIsActive;

  if (activeBoundSession && (criticalIdentityChange || !context.primaryAcceleratorAvailable || !context.legacyGpuMatches)) {
    return {
      severity: 'QUARANTINE',
      publishable: false,
      freezeSession: true,
      reason: 'CRITICAL_CHANGE_DURING_SESSION',
    };
  }

  if (!context.primaryAcceleratorAvailable) {
    return {
      severity: 'VERIFY',
      publishable: false,
      freezeSession: false,
      reason: 'PRIMARY_ACCELERATOR_UNAVAILABLE',
    };
  }

  if (!context.legacyGpuMatches) {
    return {
      severity: 'VERIFY',
      publishable: false,
      freezeSession: false,
      reason: 'LEGACY_GPU_MISMATCH',
    };
  }

  if (inventoryChanged) {
    return {
      severity: 'VERIFY',
      publishable: false,
      freezeSession: false,
      reason: 'INVENTORY_CHANGED',
    };
  }

  return {
    severity: 'NONE',
    publishable: true,
    freezeSession: false,
    reason: 'NO_CHANGE',
  };
}
