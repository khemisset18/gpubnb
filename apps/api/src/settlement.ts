export type Settlement={grossLamports:bigint,payableLamports:bigint,platformLamports:bigint,providerLamports:bigint,refundLamports:bigint,availabilityBps:number};
export const PLATFORM_COMMISSION_BPS = 500;
export function calculateSettlement(gross:bigint, validSeconds:number, expectedSeconds:number):Settlement{
 if(gross<=0n) throw new Error('gross must be positive');
 if(!Number.isInteger(validSeconds)||!Number.isInteger(expectedSeconds)||expectedSeconds<=0||validSeconds<0||validSeconds>expectedSeconds) throw new Error('invalid duration');
 const availabilityBps=Math.floor(validSeconds*10_000/expectedSeconds);
 const payable=availabilityBps>=9000 ? gross : gross*BigInt(validSeconds)/BigInt(expectedSeconds);
 const platform=payable*BigInt(PLATFORM_COMMISSION_BPS)/10_000n;
 const provider=payable-platform;
 const refund=gross-payable;
 if(provider+platform+refund!==gross) throw new Error('settlement invariant failed');
 return {grossLamports:gross,payableLamports:payable,platformLamports:platform,providerLamports:provider,refundLamports:refund,availabilityBps};
}
export const bigintJson=(value:bigint)=>value.toString(10);
