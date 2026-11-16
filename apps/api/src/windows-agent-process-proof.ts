import { z } from 'zod';

const sha40=z.string().regex(/^[0-9a-f]{40}$/);
const sha256=z.string().regex(/^[0-9a-f]{64}$/);
export const windowsAgentProcessProofSchema=z.object({
  schemaVersion:z.literal(1),machineId:z.string().min(1).max(100),challenge:z.string().min(16).max(200),
  pid:z.number().int().positive(),startedAt:z.string().datetime(),measuredAt:z.string().datetime(),
  version:z.string().min(1).max(40),commit:sha40,sha256,
  signatureStatus:z.literal('Valid'),signerThumbprint:sha40,
}).strict();
const pinSchema=z.object({version:z.string().min(1).max(40),commit:sha40,sha256,
  signerThumbprint:sha40,startedAfter:z.string().datetime()}).strict();

// These are non-secret release expectations provisioned by a separate authorized
// release process. Missing/malformed pins never become an implicit trust-on-first-use.
export function verifyWindowsAgentProcessProof(raw:unknown,context:{
  machineId:string;challenge:string;approvedCommit:string|null;nowMs?:number;
  pinsJson?:string;
}):boolean{
  const parsed=windowsAgentProcessProofSchema.safeParse(raw);
  if(!parsed.success||!context.approvedCommit)return false;
  let pins:unknown;
  try{pins=JSON.parse(context.pinsJson??process.env.WINDOWS_AGENT_PROCESS_PINS??'{}');}catch{return false;}
  if(!pins||typeof pins!=='object'||Array.isArray(pins)||!Object.hasOwn(pins,context.machineId))return false;
  const expected=pinSchema.safeParse((pins as Record<string,unknown>)[context.machineId]);
  if(!expected.success)return false;
  const p=parsed.data,e=expected.data,now=context.nowMs??Date.now();
  const started=Date.parse(p.startedAt),measured=Date.parse(p.measuredAt),floor=Date.parse(e.startedAfter);
  return p.machineId===context.machineId&&p.challenge===context.challenge
    &&p.commit===context.approvedCommit&&p.commit===e.commit&&p.version===e.version
    &&p.sha256===e.sha256&&p.signerThumbprint===e.signerThumbprint
    &&started>=floor&&started<=measured&&measured<=now+5000&&now-measured<=60000&&floor<=now;
}
// This verifies a fresh, signed MACHINE CLAIM. A holder of the machine key can
// still lie about its own measurements. It is not TPM/measured-boot attestation.
