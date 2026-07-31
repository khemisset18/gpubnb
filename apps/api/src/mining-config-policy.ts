import { z } from 'zod';

import {
  isMiningProfileApproved,
  type MiningGpuVendor,
} from './mining-profile-catalog.js';

export const miningModeSchema = z.enum(['DISABLED', 'GPUBNB_MANAGED', 'OWNER_POOL']);
export const miningResourceKindSchema = z.enum(['GPU', 'CPU']);

const resourceIdentifierSchema = z.string().trim().min(3).max(128).regex(/^[A-Za-z0-9:_-]+$/);

export const miningConfigurationInputSchema = z
  .object({
    mode: miningModeSchema,
    resourceKind: miningResourceKindSchema,
    resourceId: resourceIdentifierSchema,
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
    autoResumeAfterRental: z.boolean().default(false),
    maximumTemperatureC: z.number().int().min(40).max(95),
    maximumPowerWatts: z.number().int().min(5).max(1500),
    cpuThreadLimit: z.number().int().min(1).max(1024).optional(),
    cpuUtilizationLimitPercent: z.number().int().min(1).max(100).optional(),
    gpuIntensityPercent: z.number().int().min(1).max(100).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    if (value.resourceKind === 'CPU') {
      if (!value.cpuThreadLimit) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cpuThreadLimit'],
          message: 'cpu_thread_limit_required',
        });
      }
      if (!value.cpuUtilizationLimitPercent) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cpuUtilizationLimitPercent'],
          message: 'cpu_utilization_limit_required',
        });
      }
      if (value.gpuIntensityPercent !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gpuIntensityPercent'],
          message: 'cpu_resource_rejects_gpu_intensity',
        });
      }
    }

    if (value.resourceKind === 'GPU') {
      if (!value.gpuIntensityPercent) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gpuIntensityPercent'],
          message: 'gpu_intensity_required',
        });
      }
      if (value.cpuThreadLimit !== undefined || value.cpuUtilizationLimitPercent !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cpuThreadLimit'],
          message: 'gpu_resource_rejects_cpu_limits',
        });
      }
    }

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
  resourceMachineId: string;
  requestedMachineId: string;
  resourceKind: MiningConfigurationInput['resourceKind'];
  resourceId: string;
  gpuVendor?: MiningGpuVendor;
  rentedResourceIds: ReadonlySet<string>;
  machineExclusiveRental: boolean;
  resourceQuarantined: boolean;
  currentVersion: number;
};

export function authorizeMiningConfigurationUpdate(
  input: MiningConfigurationInput,
  context: MiningConfigurationContext,
): void {
  if (context.ownerId !== context.machineOwnerId) {
    throw new Error('machine_owner_required');
  }
  if (context.resourceMachineId !== context.requestedMachineId) {
    throw new Error('resource_machine_mismatch');
  }
  if (input.resourceKind !== context.resourceKind || input.resourceId !== context.resourceId) {
    throw new Error('resource_identity_mismatch');
  }
  if (context.machineExclusiveRental || context.rentedResourceIds.has(context.resourceId)) {
    throw new Error('mining_configuration_locked_during_rental');
  }
  if (context.resourceQuarantined && input.mode !== 'DISABLED') {
    throw new Error('quarantined_resource_cannot_mine');
  }
  if (input.expectedVersion !== context.currentVersion) {
    throw new Error('mining_configuration_version_conflict');
  }

  if (
    input.mode !== 'DISABLED'
    && !isMiningProfileApproved(input.profileId, input.resourceKind, context.gpuVendor)
  ) {
    throw new Error('mining_profile_not_approved');
  }
}

export function resourceMustStopForRental(input: {
  resourceId: string;
  rentedResourceIds: ReadonlySet<string>;
  machineExclusiveRental: boolean;
}): boolean {
  return input.machineExclusiveRental || input.rentedResourceIds.has(input.resourceId);
}

export function platformFeeBasisPoints(mode: MiningConfigurationInput['mode']): number {
  return mode === 'GPUBNB_MANAGED' ? 100 : 0;
}
