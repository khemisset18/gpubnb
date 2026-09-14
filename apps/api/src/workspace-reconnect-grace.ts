import {
  BookingStatus,
  Prisma,
  ResourceAllocationStatus,
  SessionTerminationReason,
  WorkspaceSessionStatus,
  type PrismaClient,
} from '@prisma/client';

import { runBookingTransaction } from './booking-transaction-retry.js';

export const WORKSPACE_RECONNECT_GRACE_SECONDS = 10 * 60;
export const WORKSPACE_RECONNECT_PROTOCOL_VERSION = 1;
export const RECONNECT_METADATA_KEY = 'reconnectGrace';

const LIVE_ALLOCATION_STATUSES: ResourceAllocationStatus[] = [
  ResourceAllocationStatus.HELD,
  ResourceAllocationStatus.CONFIRMED,
  ResourceAllocationStatus.ACTIVE,
];

const RECONNECT_TERMINATION_STEPS = new Set([
  'RECONNECT_GRACE_EXPIRED',
  'RECONNECT_SUSPEND_FAILED',
]);

type JsonRecord = Record<string, unknown>;

export type WorkspaceReconnectState = {
  protocolVersion: 1;
  interruptedAt: string;
  reconnectDeadlineAt: string;
  originalEndsAt: string;
};

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function validDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseWorkspaceReconnectState(metadata: unknown): WorkspaceReconnectState | null {
  const root = asRecord(metadata);
  const raw = asRecord(root?.[RECONNECT_METADATA_KEY]);
  if (!raw || raw.protocolVersion !== WORKSPACE_RECONNECT_PROTOCOL_VERSION) return null;
  const interruptedAt = validDate(raw.interruptedAt);
  const reconnectDeadlineAt = validDate(raw.reconnectDeadlineAt);
  const originalEndsAt = validDate(raw.originalEndsAt);
  if (!interruptedAt || !reconnectDeadlineAt || !originalEndsAt) return null;
  if (reconnectDeadlineAt.getTime() <= interruptedAt.getTime()) return null;
  return {
    protocolVersion: WORKSPACE_RECONNECT_PROTOCOL_VERSION,
    interruptedAt: interruptedAt.toISOString(),
    reconnectDeadlineAt: reconnectDeadlineAt.toISOString(),
    originalEndsAt: originalEndsAt.toISOString(),
  };
}

function metadataWithReconnect(metadata: unknown, state: WorkspaceReconnectState): Prisma.InputJsonObject {
  const root = asRecord(metadata) ?? {};
  return {
    ...root,
    [RECONNECT_METADATA_KEY]: state,
  } as Prisma.InputJsonObject;
}

function metadataWithoutReconnect(metadata: unknown): Prisma.InputJsonObject {
  const root = { ...(asRecord(metadata) ?? {}) };
  delete root[RECONNECT_METADATA_KEY];
  return root as Prisma.InputJsonObject;
}

export function provisionalReconnectEndsAt(originalEndsAt: Date): Date {
  return new Date(originalEndsAt.getTime() + WORKSPACE_RECONNECT_GRACE_SECONDS * 1000);
}

export function resumedReconnectEndsAt(originalEndsAt: Date, interruptedAt: Date, resumedAt: Date): Date {
  const pausedMs = Math.max(0, resumedAt.getTime() - interruptedAt.getTime());
  return new Date(originalEndsAt.getTime() + pausedMs);
}

async function lockSession(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 0))`;
}

export async function beginWorkspaceReconnectGrace(
  db: PrismaClient,
  sessionId: string,
  machineId: string,
  now = new Date(),
): Promise<{
  paused: boolean;
  alreadyPaused: boolean;
  reconnectDeadlineAt?: Date;
  provisionalEndsAt?: Date;
}> {
  return runBookingTransaction(db, async (tx) => {
    await lockSession(tx, sessionId);
    const row = await tx.workspaceSession.findFirst({
      where: {
        id: sessionId,
        machineId,
        status: WorkspaceSessionStatus.RUNNING,
        startedAt: { not: null },
        booking: { status: BookingStatus.ACTIVE },
      },
      select: {
        id: true,
        bookingId: true,
        connectionMetadata: true,
        booking: { select: { endsAt: true } },
      },
    });
    if (!row) return { paused: false, alreadyPaused: false };

    const existing = parseWorkspaceReconnectState(row.connectionMetadata);
    if (existing) {
      return {
        paused: true,
        alreadyPaused: true,
        reconnectDeadlineAt: new Date(existing.reconnectDeadlineAt),
        provisionalEndsAt: row.booking.endsAt,
      };
    }

    const interruptedAt = new Date(now);
    const reconnectDeadlineAt = new Date(interruptedAt.getTime() + WORKSPACE_RECONNECT_GRACE_SECONDS * 1000);
    const originalEndsAt = new Date(row.booking.endsAt);
    const provisionalEndsAt = provisionalReconnectEndsAt(originalEndsAt);
    const state: WorkspaceReconnectState = {
      protocolVersion: WORKSPACE_RECONNECT_PROTOCOL_VERSION,
      interruptedAt: interruptedAt.toISOString(),
      reconnectDeadlineAt: reconnectDeadlineAt.toISOString(),
      originalEndsAt: originalEndsAt.toISOString(),
    };

    await tx.workspaceSession.update({
      where: { id: row.id },
      data: {
        connectionMetadata: metadataWithReconnect(row.connectionMetadata, state),
        gatewayLastSeenAt: interruptedAt,
        expiresAt: provisionalEndsAt,
        preparationStep: 'CONNECTION_INTERRUPTED',
        events: {
          create: {
            actorType: 'AGENT',
            actorId: machineId,
            action: 'CONNECTION_INTERRUPTED',
            details: {
              interruptedAt: state.interruptedAt,
              reconnectDeadlineAt: state.reconnectDeadlineAt,
              originalEndsAt: state.originalEndsAt,
            },
          },
        },
      },
    });
    await tx.booking.update({ where: { id: row.bookingId }, data: { endsAt: provisionalEndsAt } });
    await tx.machineAllocation.updateMany({
      where: { bookingId: row.bookingId, status: { in: LIVE_ALLOCATION_STATUSES } },
      data: { endsAt: provisionalEndsAt },
    });
    await tx.acceleratorAllocation.updateMany({
      where: { bookingId: row.bookingId, status: { in: LIVE_ALLOCATION_STATUSES } },
      data: { endsAt: provisionalEndsAt },
    });

    return { paused: true, alreadyPaused: false, reconnectDeadlineAt, provisionalEndsAt };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
}

export async function resumeWorkspaceReconnectGrace(
  db: PrismaClient,
  sessionId: string,
  machineId: string,
  now = new Date(),
): Promise<{
  resumed: boolean;
  expired: boolean;
  resumedAt?: Date;
  finalEndsAt?: Date;
  pausedMilliseconds?: number;
}> {
  return runBookingTransaction(db, async (tx) => {
    await lockSession(tx, sessionId);
    const row = await tx.workspaceSession.findFirst({
      where: {
        id: sessionId,
        machineId,
        status: WorkspaceSessionStatus.RUNNING,
        booking: { status: BookingStatus.ACTIVE },
      },
      select: {
        id: true,
        bookingId: true,
        connectionMetadata: true,
      },
    });
    if (!row) return { resumed: false, expired: false };
    const state = parseWorkspaceReconnectState(row.connectionMetadata);
    if (!state) return { resumed: false, expired: false };

    const resumedAt = new Date(now);
    const interruptedAt = new Date(state.interruptedAt);
    const reconnectDeadlineAt = new Date(state.reconnectDeadlineAt);
    if (resumedAt.getTime() > reconnectDeadlineAt.getTime()) {
      return { resumed: false, expired: true };
    }

    const originalEndsAt = new Date(state.originalEndsAt);
    const pausedMilliseconds = Math.max(0, resumedAt.getTime() - interruptedAt.getTime());
    const finalEndsAt = resumedReconnectEndsAt(originalEndsAt, interruptedAt, resumedAt);

    await tx.workspaceSession.update({
      where: { id: row.id },
      data: {
        connectionMetadata: metadataWithoutReconnect(row.connectionMetadata),
        gatewayLastSeenAt: resumedAt,
        expiresAt: finalEndsAt,
        preparationStep: 'INTERACTIVE_WORKSPACE_CONNECTED',
        events: {
          create: {
            actorType: 'AGENT',
            actorId: machineId,
            action: 'CONNECTION_RESUMED',
            details: {
              interruptedAt: state.interruptedAt,
              resumedAt: resumedAt.toISOString(),
              pausedMilliseconds,
              finalEndsAt: finalEndsAt.toISOString(),
            },
          },
        },
      },
    });
    await tx.booking.update({ where: { id: row.bookingId }, data: { endsAt: finalEndsAt } });
    await tx.machineAllocation.updateMany({
      where: { bookingId: row.bookingId, status: { in: LIVE_ALLOCATION_STATUSES } },
      data: { endsAt: finalEndsAt },
    });
    await tx.acceleratorAllocation.updateMany({
      where: { bookingId: row.bookingId, status: { in: LIVE_ALLOCATION_STATUSES } },
      data: { endsAt: finalEndsAt },
    });

    return { resumed: true, expired: false, resumedAt, finalEndsAt, pausedMilliseconds };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
}

export async function touchWorkspaceReconnectLiveness(
  db: PrismaClient,
  sessionId: string,
  machineId: string,
  now = new Date(),
): Promise<boolean> {
  const updated = await db.workspaceSession.updateMany({
    where: {
      id: sessionId,
      machineId,
      status: { in: [WorkspaceSessionStatus.READY, WorkspaceSessionStatus.RUNNING] },
    },
    data: { gatewayLastSeenAt: now },
  });
  return updated.count === 1;
}

export async function markWorkspaceReconnectSuspendFailed(
  db: PrismaClient,
  sessionId: string,
  machineId: string,
  now = new Date(),
): Promise<boolean> {
  return runBookingTransaction(db, async (tx) => {
    await lockSession(tx, sessionId);
    const row = await tx.workspaceSession.findFirst({
      where: { id: sessionId, machineId, status: WorkspaceSessionStatus.RUNNING },
      select: { id: true, connectionMetadata: true },
    });
    if (!row || !parseWorkspaceReconnectState(row.connectionMetadata)) return false;
    await tx.workspaceSession.update({
      where: { id: row.id },
      data: {
        status: WorkspaceSessionStatus.STOP_REQUESTED,
        terminationReason: SessionTerminationReason.EXECUTION_FAILED,
        preparationStep: 'RECONNECT_SUSPEND_FAILED',
        events: {
          create: {
            actorType: 'AGENT',
            actorId: machineId,
            action: 'RECONNECT_SUSPEND_FAILED',
            details: { at: now.toISOString() },
          },
        },
      },
    });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
}

async function expireReconnectGraceForMachine(
  db: PrismaClient,
  machineId: string,
  now: Date,
): Promise<number> {
  const candidates = await db.workspaceSession.findMany({
    where: { machineId, status: WorkspaceSessionStatus.RUNNING },
    select: { id: true, connectionMetadata: true },
    take: 50,
  });
  let expired = 0;
  for (const candidate of candidates) {
    const state = parseWorkspaceReconnectState(candidate.connectionMetadata);
    if (!state || new Date(state.reconnectDeadlineAt).getTime() > now.getTime()) continue;
    const changed = await runBookingTransaction(db, async (tx) => {
      await lockSession(tx, candidate.id);
      const row = await tx.workspaceSession.findFirst({
        where: { id: candidate.id, machineId, status: WorkspaceSessionStatus.RUNNING },
        select: { id: true, connectionMetadata: true },
      });
      if (!row) return false;
      const current = parseWorkspaceReconnectState(row.connectionMetadata);
      if (!current || new Date(current.reconnectDeadlineAt).getTime() > now.getTime()) return false;
      await tx.workspaceSession.update({
        where: { id: row.id },
        data: {
          status: WorkspaceSessionStatus.STOP_REQUESTED,
          terminationReason: SessionTerminationReason.TIMEOUT,
          preparationStep: 'RECONNECT_GRACE_EXPIRED',
          events: {
            create: {
              actorType: 'PLATFORM',
              action: 'RECONNECT_GRACE_EXPIRED',
              details: {
                interruptedAt: current.interruptedAt,
                reconnectDeadlineAt: current.reconnectDeadlineAt,
                expiredAt: now.toISOString(),
              },
            },
          },
        },
      });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
    if (changed) expired += 1;
  }
  return expired;
}

async function finalizeReconnectTerminations(
  db: PrismaClient,
  machineId: string,
  now: Date,
): Promise<number> {
  const candidates = await db.workspaceSession.findMany({
    where: {
      machineId,
      status: WorkspaceSessionStatus.COMPLETED,
      preparationStep: { in: [...RECONNECT_TERMINATION_STEPS] },
      booking: { status: BookingStatus.ACTIVE },
    },
    select: { id: true, bookingId: true },
    take: 50,
  });
  let finalized = 0;
  for (const candidate of candidates) {
    const changed = await runBookingTransaction(db, async (tx) => {
      await lockSession(tx, candidate.id);
      const row = await tx.workspaceSession.findFirst({
        where: {
          id: candidate.id,
          machineId,
          status: WorkspaceSessionStatus.COMPLETED,
          preparationStep: { in: [...RECONNECT_TERMINATION_STEPS] },
          booking: { status: BookingStatus.ACTIVE },
        },
        select: { id: true, bookingId: true, connectionMetadata: true, preparationStep: true },
      });
      if (!row) return false;
      const booking = await tx.booking.updateMany({
        where: { id: row.bookingId, status: BookingStatus.ACTIVE },
        data: { status: BookingStatus.COMPLETED },
      });
      if (booking.count !== 1) return false;
      const allocationData = { status: ResourceAllocationStatus.RELEASED, releasedAt: now };
      await tx.machineAllocation.updateMany({
        where: { bookingId: row.bookingId, status: { in: LIVE_ALLOCATION_STATUSES } },
        data: allocationData,
      });
      await tx.acceleratorAllocation.updateMany({
        where: { bookingId: row.bookingId, status: { in: LIVE_ALLOCATION_STATUSES } },
        data: allocationData,
      });
      await tx.workspaceSession.update({
        where: { id: row.id },
        data: {
          connectionMetadata: metadataWithoutReconnect(row.connectionMetadata),
          events: {
            create: {
              actorType: 'PLATFORM',
              action: 'RECONNECT_TERMINATION_FINALIZED',
              details: { at: now.toISOString(), reason: row.preparationStep },
            },
          },
        },
      });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });
    if (changed) finalized += 1;
  }
  return finalized;
}

export async function reconcileWorkspaceReconnectGrace(
  db: PrismaClient,
  machineId: string,
  now = new Date(),
): Promise<{ expired: number; finalized: number }> {
  const expired = await expireReconnectGraceForMachine(db, machineId, now);
  const finalized = await finalizeReconnectTerminations(db, machineId, now);
  return { expired, finalized };
}

export async function listWorkspaceReconnectDirectives(
  db: PrismaClient,
  machineId: string,
): Promise<Array<{
  sessionId: string;
  interruptedAt: string;
  reconnectDeadlineAt: string;
}>> {
  const rows = await db.workspaceSession.findMany({
    where: { machineId, status: WorkspaceSessionStatus.RUNNING },
    select: { id: true, connectionMetadata: true },
    take: 50,
  });
  return rows.flatMap((row) => {
    const state = parseWorkspaceReconnectState(row.connectionMetadata);
    return state ? [{
      sessionId: row.id,
      interruptedAt: state.interruptedAt,
      reconnectDeadlineAt: state.reconnectDeadlineAt,
    }] : [];
  });
}
