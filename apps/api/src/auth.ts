import './pairing-code-redis-guard.js';
import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import bs58 from 'bs58'; import nacl from 'tweetnacl'; import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
export type Session={userId:string,wallet:string,createdAt:string,lastSeenAt:string};
export function walletKey(wallet:string){ return new PublicKey(wallet).toBase58(); }
const tokenHash=(token:string)=>crypto.createHmac('sha256',config.SESSION_SECRET).update(token).digest('hex');
export async function createNonce(redis:Redis,wallet:string,domain:string){
 const canonical=walletKey(wallet); const nonce=crypto.randomBytes(32).toString('base64url'); const issuedAt=new Date().toISOString();
 const message=['GPUbnb authentication',`Domain: ${domain}`,`Wallet: ${canonical}`,`Nonce: ${nonce}`,`Issued At: ${issuedAt}`,`Cluster: ${config.SOLANA_CLUSTER}`].join('\n');
 await redis.set(`nonce:${canonical}:${nonce}`,crypto.createHash('sha256').update(message).digest('hex'),'EX',300,'NX'); return {message,nonce,expiresIn:300};
}
export async function consumeNonce(redis:Redis,wallet:string,message:string,signature:string){
 const canonical=walletKey(wallet); if(message.length>1000)return false;
 const required=[`Domain: ${config.PUBLIC_APP_DOMAIN}`,`Wallet: ${canonical}`,`Cluster: ${config.SOLANA_CLUSTER}`]; if(!required.every(x=>message.includes(x)))return false;
 const nonce=/^Nonce: ([A-Za-z0-9_-]{20,})$/m.exec(message)?.[1]; if(!nonce) return false;
 const key=`nonce:${canonical}:${nonce}`; const expected=await redis.getdel(key); if(!expected) return false;
 if(crypto.createHash('sha256').update(message).digest('hex')!==expected) return false;
 try{return nacl.sign.detached.verify(new TextEncoder().encode(message),bs58.decode(signature),new PublicKey(canonical).toBytes())}catch{return false}
}
export async function issueSession(redis:Redis,reply:FastifyReply,session:Omit<Session,'lastSeenAt'>){
 const token=crypto.randomBytes(32).toString('base64url'); const now=new Date().toISOString();
 await redis.set(`session:${tokenHash(token)}`,JSON.stringify({...session,lastSeenAt:now}),'EX',config.SESSION_TTL_SECONDS);
 reply.setCookie(config.SESSION_COOKIE_NAME,token,{httpOnly:true,secure:config.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:config.SESSION_TTL_SECONDS});
}
export async function revokeSession(redis:Redis,token:string){await redis.del(`session:${tokenHash(token)}`)}
export async function requireSession(req:FastifyRequest,reply:FastifyReply,redis:Redis):Promise<Session|undefined>{
 const token=req.cookies[config.SESSION_COOKIE_NAME]; if(!token){reply.code(401).send({error:'authentication_required'});return}
 const key=`session:${tokenHash(token)}`; const raw=await redis.get(key); if(!raw){reply.code(401).send({error:'session_expired'});return}
 let session:Session; try{session=JSON.parse(raw)}catch{await redis.del(key);reply.code(401).send({error:'session_invalid'});return}
 const last=Date.parse(session.lastSeenAt); if(!Number.isFinite(last)||Date.now()-last>config.SESSION_IDLE_TTL_SECONDS*1000){await redis.del(key);reply.code(401).send({error:'session_idle_timeout'});return}
 if(Date.now()-last>60_000){session.lastSeenAt=new Date().toISOString();await redis.set(key,JSON.stringify(session),'KEEPTTL')}
 return session;
}
