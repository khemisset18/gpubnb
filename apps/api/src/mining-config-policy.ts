import { z } from 'zod';

export const miningModeSchema = z.enum(['DISABLED', 'GPUBNB_MANAGED', 'OWNER_POOL']);

export const miningConfigurationInputSchema = z
  .object({
    mode: miningModeSchema,
    acceleratorId: z.string().cuid(),
    profileId: z.string().trim().min(3).max(96).regex(/^[a-z0-9_-]+$/),
    walletAddress: z.string().trim().min(8).max(160).optional(),
    workerName: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    ownerPoolEndpoint: z
      .string()
      .trim()
      .max(300)
      .regex(/^stratum\+(tcp|ssl|tls):\/\//)
      .optional(),
    ownerPoolSecretRef: z.string().trim().min(8).max(200).optional(),
    autoResumeAfterRental: z.boolean().default(true),
    maximumTemperatureC: z.number().int().min(50).max(95),
    maximumPowerWatts: z.number().int().min(25).max(1500),
    expectedVersion: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    if (value.mode === 'DISABLED') return;

    if (!value.walletAddress) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['walletAddress'],
        message: 'wallet_required',
      });
    }

    if (value.mode === 'OWNER_POOL' && !value.ownerPoolEndpoint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerPoolEndpoint'],
        message: 'owner_pool_endpoint_required',
      });
    }

    if (value.mode === 'GPUBNB_MANAGED' && (value.ownerPoolEndpoint || value.ownerPoolSecretRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerPoolEndpoint'],
        message: 'managed_pool_rejects_owner_endpoint',
      });
    }
  });

export type MiningConfigurationInput = z.infer<typeof miningConfigurationInputSchema>;

export type MiningConfigurationContext = {
  ownerId: string;
  machineOwnerId: string;
  acceleratorMachineId: string;
  requestedMachineId: string;
  activeRental: boolean;
  acceleratorQuarantined: boolean;
  currentVersion: number;
  profileApproved: boolean;
};

export function authorizeMiningConfigurationUpdate(
  input: MiningConfigurationInput,
  context: MiningConfigurationContext,
): void {
  if (context.ownerId !== context.machineOwnerId) {
    throw new Error('machine_owner_required');
  }
  if (context.acceleratorMachineId !== context.requestedMachineId) {
    throw new Error('accelerator_machine_mismatch');
  }
  if (context.activeRental) {
    throw new Error('mining_configuration_locked_during_rental');
  }
  if (context.acceleratorQuarantined && input.mode !== 'DISABLED') {
    throw new Error('quarantined_accelerator_cannot_mine');
  }
  if (input.expectedVersion !== context.currentVersion) {
    throw new Error('mining_configuration_version_conflict');
  }
  if (input.mode !== 'DISABLED' && !context.profileApproved) {
    throw new Error('mining_profile_not_approved');
  }
}

export function platformFeeBasisPoints(mode: MiningConfigurationInput['mode']): number {
  return mode === 'GPUBNB_MANAGED' ? 100 : 0;
}
