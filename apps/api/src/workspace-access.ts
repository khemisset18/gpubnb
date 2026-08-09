import crypto from 'node:crypto';
import type { Redis } from 'ioredis';

const PREFIX='workspace-access:';
const DEFAULT_TTL_SECONDS=60;

export type WorkspaceAccessGrant={
  token:string;
  expiresIn:number;
};

type GrantRecord={
  userId:string;
  bookingId:string;
  sessionId:string;
  issuedAt:string;
};

function digest(token:string){return crypto.createHash('sha256').update(token).digest('hex');}

/** Issue a short-lived bearer capability. Only its SHA-256 digest is persisted. */
export async function issueWorkspaceAccessGrant(redis:Redis,record:Omit<GrantRecord,'issuedAt'>,ttlSeconds=DEFAULT_TTL_SECONDS):Promise<WorkspaceAccessGrant>{
  const token=crypto.randomBytes(32).toString('base64url');
  const key=`${PREFIX}${digest(token)}`;
  const value:GrantRecord={...record,issuedAt:new Date().toISOString()};
  await redis.set(key,JSON.stringify(value),'EX',ttlSeconds,'NX');
  return {token,expiresIn:ttlSeconds};
}

/** One-time consume prevents replay of the bootstrap credential. */
export async function consumeWorkspaceAccessGrant(redis:Redis,token:string):Promise<GrantRecord|null>{
  if(!token||token.length>128)return null;
  const raw=await redis.getdel(`${PREFIX}${digest(token)}`);
  if(!raw)return null;
  try{return JSON.parse(raw) as GrantRecord}catch{return null;}
}
