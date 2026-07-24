import crypto from 'node:crypto';
import {
  BookingStatus,
  PaymentStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import { calculateSettlement, type Settlement } from './settlement.js';
import { recordRentalEvent } from './rental-delivery-service.js';

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/;
const TERMINAL_BOOKING_STATUSES = new Set<BookingStatus>([
  BookingStatus.SETTLED,
  BookingStatus.REFUNDED,
]);

type TransactionClient = Prisma.TransactionClient;

export interface SettlementPreview {
  bookingId: string;
  paymentId: string;
  settlement: Settlement;
}

export interface SettlementConfirmation {
  bookingId: string;
  paymentId: string;
  bookingStatus: BookingStatus;
  paymentStatus: PaymentStatus;
  settlementSignature: string;
  settlement: Settlement;
  idempotent: boolean;
}

function assertSignature(signature: string): string {
  if (!SIGNATURE_PATTERN.test(signature)) throw new Error('settlement_signature_invalid');
  return signature;
}

function assertSettlementInvariant(settlement: Settlement): void {
  const total = settlement.providerLamports + settlement.platformLamports + settlement.refundLamports;
  if (total !== settlement.grossLamports) throw new Error('settlement_invariant_failed');
  if (settlement.payableLamports !== settlement.providerLamports + settlement.platformLamports) {
    throw new Error('settlement_payable_invariant_failed');
  }
  if (
    settlement.grossLamports < 0n ||
    settlement.payableLamports < 0n ||
    settlement.platformLamports < 0n ||
    settlement.providerLamports < 0n ||
    settlement.refundLamports < 0n
  ) {
    throw new Error('settlement_negative_amount');
  }
}

async function lockBookingAndPayment(tx: TransactionClient, bookingId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT booking."id"
    FROM "Booking" AS booking
    JOIN "Payment" AS payment ON payment."bookingId" = booking."id"
    WHERE booking."id" = ${bookingId}
    FOR UPDATE OF booking, payment
  `;
  if (locked.length !== 1) throw new Error('booking_payment_not_found');

  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      payment: true,
      listing: { select: { machineId: true } },
    },
  });
  if (!booking?.payment) throw new Error('booking_payment_not_found');
  return booking;
}

function calculateForBooking(booking: {
  quotedLamports: bigint;
  validSeconds: number;
  expectedSeconds: number;
  payment: { grossLamports: bigint };
}): Settlement {
  if (booking.payment.grossLamports !== booking.quotedLamports) {
    throw new Error('escrow_amount_mismatch');
  }
  const settlement = calculateSettlement(
    booking.payment.grossLamports,
    booking.validSeconds,
    booking.expectedSeconds,
  );
  assertSettlementInvariant(settlement);
  return settlement;
}

export async function previewSettlement(
  db: PrismaClient,
  bookingId: string,
): Promise<SettlementPreview> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true },
  });
  if (!booking?.payment) throw new Error('booking_payment_not_found');
  if (![BookingStatus.COMPLETED, BookingStatus.DEGRADED, BookingStatus.DISPUTED].includes(booking.status)) {
    throw new Error('booking_not_settleable');
  }
  return {
    bookingId,
    paymentId: booking.payment.id,
    settlement: calculateForBooking(booking),
  };
}

export async function requestSettlement(
  db: PrismaClient,
  bookingId: string,
): Promise<SettlementPreview> {
  return db.$transaction(
    async (tx) => {
      const booking = await lockBookingAndPayment(tx, bookingId);
      if (![BookingStatus.COMPLETED, BookingStatus.DEGRADED].includes(booking.status)) {
        throw new Error('booking_not_settleable');
      }
      if (booking.payment.status === PaymentStatus.FROZEN) throw new Error('payment_frozen');
      if ([PaymentStatus.RELEASED, PaymentStatus.FULLY_REFUNDED].includes(booking.payment.status)) {
        throw new Error('payment_already_terminal');
      }

      const settlement = calculateForBooking(booking);
      await tx.payment.update({
        where: { id: booking.payment.id },
        data: {
          payableLamports: settlement.payableLamports,
          platformLamports: settlement.platformLamports,
          providerLamports: settlement.providerLamports,
          refundLamports: settlement.refundLamports,
          status: PaymentStatus.SETTLEMENT_PENDING,
        },
      });

      await recordRentalEvent(tx, 'payment.settlement_requested', {
        bookingId: booking.id,
        machineId: booking.listing.machineId,
        renterId: booking.buyerId,
        listingId: booking.listingId,
        paymentId: booking.payment.id,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
      }, {
        grossLamports: settlement.grossLamports.toString(),
        payableLamports: settlement.payableLamports.toString(),
        providerLamports: settlement.providerLamports.toString(),
        platformLamports: settlement.platformLamports.toString(),
        refundLamports: settlement.refundLamports.toString(),
        availabilityBps: settlement.availabilityBps,
      });

      return { bookingId, paymentId: booking.payment.id, settlement };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function confirmSettlement(
  db: PrismaClient,
  bookingId: string,
  signatureInput: string,
): Promise<SettlementConfirmation> {
  const signature = assertSignature(signatureInput);
  return db.$transaction(
    async (tx) => {
      const booking = await lockBookingAndPayment(tx, bookingId);
      const settlement = calculateForBooking(booking);

      if (booking.payment.settlementSignature) {
        if (booking.payment.settlementSignature !== signature) {
          throw new Error('settlement_signature_conflict');
        }
        if (!TERMINAL_BOOKING_STATUSES.has(booking.status)) {
          throw new Error('settlement_terminal_state_mismatch');
        }
        return {
          bookingId,
          paymentId: booking.payment.id,
          bookingStatus: booking.status,
          paymentStatus: booking.payment.status,
          settlementSignature: signature,
          settlement,
          idempotent: true,
        };
      }

      if (booking.payment.status !== PaymentStatus.SETTLEMENT_PENDING) {
        throw new Error('settlement_not_requested');
      }
      if (![BookingStatus.COMPLETED, BookingStatus.DEGRADED].includes(booking.status)) {
        throw new Error('booking_not_settleable');
      }

      const fullRefund = settlement.refundLamports === settlement.grossLamports;
      const partialRefund = settlement.refundLamports > 0n && !fullRefund;
      const paymentStatus = fullRefund
        ? PaymentStatus.FULLY_REFUNDED
        : partialRefund
          ? PaymentStatus.PARTIALLY_REFUNDED
          : PaymentStatus.RELEASED;
      const bookingStatus = fullRefund ? BookingStatus.REFUNDED : BookingStatus.SETTLED;

      await tx.payment.update({
        where: { id: booking.payment.id },
        data: { status: paymentStatus, settlementSignature: signature },
      });
      await tx.booking.update({ where: { id: booking.id }, data: { status: bookingStatus } });

      const eventType = fullRefund ? 'payment.refunded' : 'payment.settled';
      await recordRentalEvent(tx, eventType, {
        bookingId: booking.id,
        machineId: booking.listing.machineId,
        renterId: booking.buyerId,
        listingId: booking.listingId,
        paymentId: booking.payment.id,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
      }, {
        signatureHash: crypto.createHash('sha256').update(signature).digest('hex'),
        providerLamports: settlement.providerLamports.toString(),
        platformLamports: settlement.platformLamports.toString(),
        refundLamports: settlement.refundLamports.toString(),
      });

      return {
        bookingId,
        paymentId: booking.payment.id,
        bookingStatus,
        paymentStatus,
        settlementSignature: signature,
        settlement,
        idempotent: false,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
