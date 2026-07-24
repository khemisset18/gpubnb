export type OfflineSweepInput = {
  machineIds: string[];
  activeBookingIds: string[];
  activeWorkspaceSessionIds: string[];
  activeJobIds: string[];
};

export type OfflineSweepPlan = {
  machineIds: string[];
  listingMachineIds: string[];
  degradedBookingIds: string[];
  failedWorkspaceSessionIds: string[];
  cancelledJobIds: string[];
  stopValidatedUsage: true;
};

const uniqueSorted = (values: string[]): string[] =>
  [...new Set(values.filter(Boolean))].sort();

/**
 * Builds the authoritative and idempotent state-transition plan applied when
 * one or more agents miss the heartbeat deadline.
 *
 * Payment safety invariant: no usage interval may be validated after this
 * transition begins. Callers must execute the resulting updates in one DB
 * transaction before accepting any further usage samples for these machines.
 */
export function buildOfflineSweepPlan(input: OfflineSweepInput): OfflineSweepPlan {
  return {
    machineIds: uniqueSorted(input.machineIds),
    listingMachineIds: uniqueSorted(input.machineIds),
    degradedBookingIds: uniqueSorted(input.activeBookingIds),
    failedWorkspaceSessionIds: uniqueSorted(input.activeWorkspaceSessionIds),
    cancelledJobIds: uniqueSorted(input.activeJobIds),
    stopValidatedUsage: true,
  };
}

export function heartbeatCutoff(now: Date, offlineAfterSeconds: number): Date {
  if (!Number.isInteger(offlineAfterSeconds) || offlineAfterSeconds < 1) {
    throw new RangeError('offlineAfterSeconds must be a positive integer');
  }
  return new Date(now.getTime() - offlineAfterSeconds * 1000);
}
