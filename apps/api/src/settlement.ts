export type Settlement={grossLamports:bigint,payableLamports:bigint,platformLamports:bigint,providerLamports:bigint,refundLamports:bigint,availabilityBps:number};
export const ESCROW_EXPIRY_GRACE_SECONDS = 3600n;
export const BILLING_UNIT_SECONDS = 60;

export function bookingEscrowExpiryUnix(endsAt: Date): bigint {
 if(Number.isNaN(endsAt.getTime())) throw new Error('invalid booking end');
 return BigInt(Math.floor(endsAt.getTime()/1000))+ESCROW_EXPIRY_GRACE_SECONDS;
}

/**
 * Settles an escrow by server-validated whole minutes of service.
 *
 * A partial minute is not billed. Reservation duration is rounded up to the
 * next minute so the renter is never overcharged. A fully completed booking
 * still settles the full escrow, including reservations whose duration is not
 * an exact multiple of one minute.
 *
 * Example: 45 validated minutes of a 60-minute, 6 EUR reservation makes
 * 4.50 EUR payable before platform commission and refunds the remaining 1.50 EUR.
 */
export function calculateSettlement(gross:bigint, validSeconds:number, expectedSeconds:number, commissionBps=500):Settlement{
 if(gross<=0n) throw new Error('gross must be positive');
 if(!Number.isSafeInteger(validSeconds)||!Number.isSafeInteger(expectedSeconds)||expectedSeconds<=0||validSeconds<0||validSeconds>expectedSeconds) throw new Error('invalid duration');
 if(!Number.isInteger(commissionBps)||commissionBps<0||commissionBps>10_000) throw new Error('invalid commission');
 const availabilityBps=Math.floor(validSeconds*10_000/expectedSeconds);
 const expectedMinutes=Math.ceil(expectedSeconds/BILLING_UNIT_SECONDS);
 const validatedMinutes=Math.floor(validSeconds/BILLING_UNIT_SECONDS);
 const billableMinutes=validSeconds===expectedSeconds?expectedMinutes:Math.min(validatedMinutes,expectedMinutes);
 const payable=gross*BigInt(billableMinutes)/BigInt(expectedMinutes);
 const platform=payable*BigInt(commissionBps)/10_000n;
 const provider=payable-platform;
 const refund=gross-payable;
 if(provider<0n||platform<0n||refund<0n||provider+platform+refund!==gross) throw new Error('settlement invariant failed');
 return {grossLamports:gross,payableLamports:payable,platformLamports:platform,providerLamports:provider,refundLamports:refund,availabilityBps};
}

export const bigintJson=(value:bigint)=>value.toString(10);