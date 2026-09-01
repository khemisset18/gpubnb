import type { PrismaClient } from '@prisma/client';
import { BookingStatus, ResourceAllocationStatus } from '@prisma/client';

export type RepairActionCode = 'CLEAR_ORPHANED_ALLOCATIONS';

export type RepairActionDefinition = {
  code: RepairActionCode;
  title: string;
  description: string;
  /** Only actions GPUbnb-owned bookkeeping can safely correct on its own are
   * ever exposed. Nothing here ever touches a live/foreign process on the
   * machine, and nothing here ever touches MiningResource.activeRentalId (the
   * real booking-exclusivity gate) - only allocation rows already orphaned by
   * a booking that has actually reached a terminal state. */
  safe: true;
};

export const REPAIR_ACTIONS: Record<RepairActionCode, RepairActionDefinition> = {
  CLEAR_ORPHANED_ALLOCATIONS: {
    code: 'CLEAR_ORPHANED_ALLOCATIONS',
    title: 'Nettoyer les allocations GPU orphelines',
    description:
      "Corrige les enregistrements internes d'allocation GPU restés à l'état actif alors que la réservation associée est déjà terminée (COMPLETED) ou annulée (CANCELLED). N'affecte aucun processus réel sur la machine ni la ressource GPU elle-même.",
    safe: true,
  },
};

const TERMINAL_BOOKING_STATUSES: BookingStatus[] = [BookingStatus.COMPLETED, BookingStatus.CANCELLED];
const STUCK_ALLOCATION_STATUSES: ResourceAllocationStatus[] = [
  ResourceAllocationStatus.HELD,
  ResourceAllocationStatus.CONFIRMED,
  ResourceAllocationStatus.ACTIVE,
];

export type RepairResult = { action: RepairActionCode; changed: number };

/** Detects whether a safe repair exists for this machine right now, without
 * applying it - used to decide whether Host shows the "Réparer" button at all. */
export async function detectAvailableRepair(db: PrismaClient, machineId: string): Promise<RepairActionCode | null> {
  const orphan = await db.acceleratorAllocation.findFirst({
    where: {
      status: { in: STUCK_ALLOCATION_STATUSES },
      releasedAt: null,
      accelerator: { machineId },
      booking: { status: { in: TERMINAL_BOOKING_STATUSES } },
    },
    select: { id: true },
  });
  return orphan ? 'CLEAR_ORPHANED_ALLOCATIONS' : null;
}

/**
 * Applies CLEAR_ORPHANED_ALLOCATIONS. Never changes Machine.moderationStatus or
 * MachineOperational - a repair only ever corrects GPUbnb's own bookkeeping. The
 * caller (machine-diagnostics-routes.ts) is responsible for requiring a fresh
 * diagnostic afterwards before any quarantine can be lifted.
 */
export async function applyRepair(
  db: PrismaClient,
  machineId: string,
  action: RepairActionCode,
): Promise<RepairResult> {
  if (action !== 'CLEAR_ORPHANED_ALLOCATIONS') throw new Error('unknown_repair_action');
  const now = new Date();
  return db.$transaction(async (tx) => {
    const orphans = await tx.acceleratorAllocation.findMany({
      where: {
        status: { in: STUCK_ALLOCATION_STATUSES },
        releasedAt: null,
        accelerator: { machineId },
        booking: { status: { in: TERMINAL_BOOKING_STATUSES } },
      },
      select: { id: true },
    });
    if (!orphans.length) return { action, changed: 0 };
    await tx.acceleratorAllocation.updateMany({
      where: { id: { in: orphans.map((o) => o.id) } },
      data: { status: ResourceAllocationStatus.RELEASED, releasedAt: now },
    });
    return { action, changed: orphans.length };
  });
}
