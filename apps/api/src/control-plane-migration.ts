export type MachinePresenceMode = 'legacy' | 'shadow' | 'hot';
export type PresenceReadAuthority = 'LEGACY_DATABASE' | 'HOT_REDIS';

export interface ControlPlaneMigrationPlan {
  mode: MachinePresenceMode;
  writeLegacyRuntime: boolean;
  writeHotPresence: boolean;
  presenceReadAuthority: PresenceReadAuthority;
  legacyPollingFallbackAllowed: boolean;
}

const PLANS: Record<MachinePresenceMode, ControlPlaneMigrationPlan> = Object.freeze({
  legacy: Object.freeze({
    mode: 'legacy',
    writeLegacyRuntime: true,
    writeHotPresence: false,
    presenceReadAuthority: 'LEGACY_DATABASE',
    legacyPollingFallbackAllowed: true,
  }),
  shadow: Object.freeze({
    mode: 'shadow',
    writeLegacyRuntime: true,
    writeHotPresence: true,
    presenceReadAuthority: 'LEGACY_DATABASE',
    legacyPollingFallbackAllowed: true,
  }),
  hot: Object.freeze({
    mode: 'hot',
    writeLegacyRuntime: false,
    writeHotPresence: true,
    presenceReadAuthority: 'HOT_REDIS',
    legacyPollingFallbackAllowed: true,
  }),
});

export function controlPlaneMigrationPlan(mode: MachinePresenceMode): ControlPlaneMigrationPlan {
  const plan = PLANS[mode];
  if (!plan) throw new Error('machine_presence_mode_invalid');
  assertSafeMigrationPlan(plan);
  return plan;
}

export function assertSafeMigrationPlan(plan: ControlPlaneMigrationPlan): void {
  if (plan.mode === 'legacy') {
    if (!plan.writeLegacyRuntime || plan.writeHotPresence || plan.presenceReadAuthority !== 'LEGACY_DATABASE') {
      throw new Error('legacy_presence_plan_unsafe');
    }
    return;
  }
  if (plan.mode === 'shadow') {
    if (!plan.writeLegacyRuntime || !plan.writeHotPresence || plan.presenceReadAuthority !== 'LEGACY_DATABASE') {
      throw new Error('shadow_presence_plan_unsafe');
    }
    return;
  }
  if (plan.mode === 'hot') {
    if (plan.writeLegacyRuntime || !plan.writeHotPresence || plan.presenceReadAuthority !== 'HOT_REDIS') {
      throw new Error('hot_presence_plan_unsafe');
    }
    return;
  }
  throw new Error('machine_presence_mode_invalid');
}
