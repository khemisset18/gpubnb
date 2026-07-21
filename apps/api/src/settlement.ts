export type Settlement={grossLamports:bigint,payableLamports:bigint,platformLamports:bigint,providerLamports:bigint,refundLamports:bigint,availabilityBps:number};
export function calculateSettlement(gross:bigint, validSeconds:number, expectedSeconds:number, commissionBps=500):Settlement{
 if(gross<=0n) throw new Error('gross must be positive');
 if(!Number.isInteger(validSeconds)||!Number.isInteger(expectedSeconds)||expectedSeconds<=0||validSeconds<0||validSeconds>expectedSeconds) throw new Error('invalid duration');
 if(!Number.isInteger(commissionBps)||commissionBps<0||commissionBps>10_000) throw new Error('invalid commission');
 const availabilityBps=Math.floor(validSeconds*10_000/expectedSeconds);
 const payable=availabilityBps>=9000 ? gross : gross*BigInt(validSeconds)/BigInt(expectedSeconds);
 const platform=payable*BigInt(commissionBps)/10_000n;
 const provider=payable-platform;
 const refund=gross-payable;
 if(provider+platform+refund!==gross) throw new Error('settlement invariant failed');
 return {grossLamports:gross,payableLamports:payable,platformLamports:platform,providerLamports:provider,refundLamports:refund,availabilityBps};
}
export const bigintJson=(value:bigint)=>value.toString(10);
