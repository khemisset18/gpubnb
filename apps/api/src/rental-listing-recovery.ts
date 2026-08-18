import {
  ListingResourceMode,
  ListingStatus,
  Prisma,
} from '@prisma/client';

import { isExactGpuPubliclyHealthy } from './rental-public-listings.js';

const recoverySelect = {
  id: true,
  accelerators: {
    take: 2,
    select: {
      accelerator: {
        select: {
          status: true,
          moderationStatus: true,
          isolationVerified: true,
          verifiedAt: true,
          lastSeenAt: true,
          miningResource: {
            select: {
              enabled: true,
              quarantined: true,
              runtimeState: true,
              lastSeenAt: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.GpuListingSelect;

export async function reactivateHealthyOfflineListings(
  tx: Prisma.TransactionClient,
  machineId: string,
  now: Date,
  staleAfterSeconds: number,
): Promise<string[]> {
  const listings = await tx.gpuListing.findMany({
    where: {
      machineId,
      status: ListingStatus.HIDDEN_OFFLINE,
      resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
    },
    select: recoverySelect,
  });

  const recovered: string[] = [];
  for (const listing of listings) {
    if (listing.accelerators.length !== 1) continue;
    const selected = listing.accelerators.at(0);
    if (!selected) continue;
    if (!isExactGpuPubliclyHealthy(selected.accelerator, now, staleAfterSeconds)) continue;

    const updated = await tx.gpuListing.updateMany({
      where: {
        id: listing.id,
        status: ListingStatus.HIDDEN_OFFLINE,
      },
      data: { status: ListingStatus.ACTIVE },
    });
    if (updated.count === 1) recovered.push(listing.id);
  }

  return recovered;
}
