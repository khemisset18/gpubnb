import type { Prisma, PrismaClient } from '@prisma/client';
import { sanitizeAccelerators } from './accelerator-telemetry.js';
import { syncMachineAccelerators } from './accelerator-inventory-store.js';
import { decideAcceleratorSecurity } from './accelerator-security-policy.js';
import { enforceAcceleratorSecurityDecision } from './accelerator-security-executor.js';
import { syncGpuMiningResourcesFromAccelerators } from './mining-resource-inventory.js';
import { reactivateHealthyOfflineListings } from './rental-listing-recovery.js';
import { rentalHeartbeatOfflineSeconds } from './rental-runtime-policy.js';

export type AcceleratorHeartbeatContext = {
  machineId: string;
  historicalGpuUuid: string | null;
  sessionActive: boolean;
  rawAccelerators: unknown;
};

export async function processAcceleratorHeartbeat(
  tx: Prisma.TransactionClient,
  context: AcceleratorHeartbeatContext,
) {
  const accelerators = sanitizeAccelerators(context.rawAccelerators);
  const sync = await syncMachineAccelerators(
    tx as unknown as Pick<PrismaClient, '$queryRaw' | '$executeRaw'>,
    context.machineId,
    accelerators,
  );

  await syncGpuMiningResourcesFromAccelerators(tx, context.machineId, accelerators);

  const primaryGpu = accelerators.find((item) => item.kind === 'GPU' && item.available)
    ?? accelerators.find((item) => item.kind === 'GPU')
    ?? null;

  const decision = decideAcceleratorSecurity(sync, {
    hasBoundSession: context.sessionActive,
    sessionIsActive: context.sessionActive,
    primaryAcceleratorAvailable: Boolean(primaryGpu?.available),
    legacyGpuMatches: !context.historicalGpuUuid || primaryGpu?.deviceId === context.historicalGpuUuid,
  });

  const enforcement = await enforceAcceleratorSecurityDecision(
    tx,
    context.machineId,
    decision,
  );

  const publishable = decision.publishable && Boolean(primaryGpu?.available);
  const recoveredListings = publishable
    ? await reactivateHealthyOfflineListings(
      tx,
      context.machineId,
      new Date(),
      rentalHeartbeatOfflineSeconds(),
    )
    : [];

  return {
    accelerators,
    primaryGpu,
    sync,
    decision,
    enforcement,
    recoveredListings,
    publishable,
  };
}

export async function processAcceleratorHeartbeatTransactionally(
  db: PrismaClient,
  context: AcceleratorHeartbeatContext,
) {
  return db.$transaction(
    (tx) => processAcceleratorHeartbeat(tx, context),
    { isolationLevel: 'Serializable' },
  );
}
