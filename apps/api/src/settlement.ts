export type Settlement={grossLamports:bigint,payableLamports:bigint,platformLamports:bigint,providerLamports:bigint,refundLamports:bigint,availabilityBps:number};
export const ESCROW_EXPIRY_GRACE_SECONDS = 3600n;

export function bookingEscrowExpiryUnix(endsAt: Date): bigint {
 if(Number.isNaN(endsAt.getTime())) throw new Error('invalid booking end');
 return BigInt(Math.floor(endsAt.getTime()/1000))+ESCROW_EXPIRY_GRACE_SECONDS;
}

/**
 * Settles an escrow strictly in proportion to server-validated service time.
 *
 * No availability threshold grants full payment: if a provider serves 40 minutes
 * of a 60-minute reservation, only 40/60 of the escrow is payable and 20/60 is
 * refunded. Rounding is intentionally biased toward the renter because integer
 * division floors the payable amount; the accounting invariant always remains exact.
 */
export function calculateSettlement(gross:bigint, validSeconds:number, expectedSeconds:number, commissionBps=500):Settlement{
 if(gross<=0n) throw new Error('gross must be positive');
 if(!Number.isSafeInteger(validSeconds)||!Number.isSafeInteger(expectedSeconds)||expectedSeconds<=0||validSeconds<0||validSeconds>expectedSeconds) throw new Error('invalid duration');
 if(!Number.isInteger(commissionBps)||commissionBps<0||commissionBps>10_000) throw new Error('invalid commission');
 const availabilityBps=Math.floor(validSeconds*10_000/expectedSeconds);
 const payable=gross*BigInt(validSeconds)/BigInt(expectedSeconds);
 const platform=payable*BigInt(commissionBps)/10_000n;
 const provider=payable-platform;
 const refund=gross-payable;
 if(provider<0n||platform<0n||refund<0n||provider+platform+refund!==gross) throw new Error('settlement invariant failed');
 return {grossLamports:gross,payableLamports:payable,platformLamports:platform,providerLamports:provider,refundLamports:refund,availabilityBps};
}

export const bigintJson=(value:bigint)=>value.toString(10);
