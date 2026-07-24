import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  BookingStatus,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  ModerationStatus,
  PaymentStatus,
  WorkspaceSessionStatus,
  SessionTerminationReason,
} from '@prisma/client';
import type { AcceleratorSecurityDecision } from './accelerator-security-policy.js';

const activeBookingStatuses = [
  BookingStatus.FUNDED,
  BookingStatus.STARTING,
  BookingStatus.ACTIVE,
  BookingStatus.DEGRADED,
];

const activeWorkspaceStatuses = [
  WorkspaceSessionStatus.RESERVED,
  WorkspaceSessionStatus.PREPARING,
  WorkspaceSessionStatus.READY,
  WorkspaceSessionStatus.RUNNING,
  WorkspaceSessionStatus.STOP_REQUESTED,
  WorkspaceSessionStatus.STOPPING,
];

export type AcceleratorSecurityExecution = {
  severity: AcceleratorSecurityDecision['severity'];
  hiddenListings: number;
  frozenPayments: number;
  quarantinedSessions: number;
  degradedBookings: number;
};

export async function enforceAcceleratorSecurityDecision(
  tx: Prisma.TransactionClient,
  machineId: string,
  decision: AcceleratorSecurityDecision,
  now = new Date(),
): Promise<AcceleratorSecurityExecution> {
  const result: AcceleratorSecurityExecution = {
    severity: decision.severity,
    hiddenListings: 0,
    frozenPayments: 0,
    quarantinedSessions: 0,
    degradedBookings: 0,
  };

  if (decision.severity === 'NONE') return result;

  const listings = await tx.gpuListing.updateMany({
    where: {
      machineId,
      status: { in: [ListingStatus.ACTIVE, ListingStatus.RESERVED] },
    },
    data: { status: ListingStatus.PENDING_GPU_VERIFICATION },
  });
  result.hiddenListings = listings.count;

  if (decision.severity === 'VERIFY') {
    await tx.machine.update({
      where: { id: machineId },
      data: {
        operational: MachineOperational.VERIFYING,
        verifiedAt: null,
      },
    });
    return result;
  }

  await tx.machine.update({
    where: { id: machineId },
    data: {
      moderationStatus: ModerationStatus.QUARANTINED,
      connectivity: MachineConnectivity.OFFLINE,
      operational: MachineOperational.UNAVAILABLE,
      verifiedAt: null,
    },
  });

  const bookings = await tx.booking.findMany({
    where: {
      listing: { machineId },
      status: { in: activeBookingStatuses },
      startsAt: { lte: now },
      endsAt: { gte: now },
    },
    select: { id: true },
  });
  const bookingIds = bookings.map((booking) => booking.id);

  if (bookingIds.length > 0) {
    const degraded = await tx.booking.updateMany({
      where: { id: { in: bookingIds }, status: { in: activeBookingStatuses } },
      data: { status: BookingStatus.DEGRADED },
    });
    result.degradedBookings = degraded.count;

    const frozen = await tx.payment.updateMany({
      where: {
        bookingId: { in: bookingIds },
        status: {
          in: [
            PaymentStatus.ESCROW_FUNDED,
            PaymentStatus.SETTLEMENT_PENDING,
            PaymentStatus.PARTIALLY_REFUNDED,
          ],
        },
      },
      data: { status: PaymentStatus.FROZEN },
    });
    result.frozenPayments = frozen.count;

    const sessions = await tx.workspaceSession.updateMany({
      where: {
        bookingId: { in: bookingIds },
        status: { in: activeWorkspaceStatuses },
      },
      data: {
        status: WorkspaceSessionStatus.QUARANTINED,
        terminationReason: SessionTerminationReason.SECURITY_POLICY,
        endedAt: now,
      },
    });
    result.quarantinedSessions = sessions.count;

    for (const bookingId of bookingIds) {
      const session = await tx.workspaceSession.findUnique({
        where: { bookingId },
        select: { id: true },
      });
      if (!session) continue;
      await tx.workspaceSessionEvent.create({
        data: {
          id: `wse_${crypto.randomBytes(16).toString('hex')}`,
          sessionId: session.id,
          actorType: 'PLATFORM',
          action: 'ACCELERATOR_SECURITY_QUARANTINE',
          details: {
            reason: decision.reason,
            machineId,
          },
        },
      });
    }
  }

  return result;
}

export async function enforceAcceleratorSecurityDecisionTransactionally(
  db: PrismaClient,
  machineId: string,
  decision: AcceleratorSecurityDecision,
): Promise<AcceleratorSecurityExecution> {
  return db.$transaction(
    (tx) => enforceAcceleratorSecurityDecision(tx, machineId, decision),
    { isolationLevel: 'Serializable' },
  );
}
