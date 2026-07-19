import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import bs58 from 'bs58'; import nacl from 'tweetnacl'; import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
export type Session={userId:string,wallet:string,createdAt:string};
export function walletKey(wallet:string){ return new PublicKey(wallet).toBase58(); }
export async function createNonce(redis:Redis,wallet:string,domain:string){
 const canonical=walletKey(wallet); const nonce=crypto.randomBytes(32).toString('base64url'); const issuedAt=new Date().toISOString();
 const message=['GPUbnb authentication',`Domain: ${domain}`,`Wallet: ${canonical}`,`Nonce: ${nonce}`,`Issued At: ${issuedAt}`,`Cluster: ${config.SOLANA_CLUSTER}`].join('\n');
 await redis.set(`nonce:${canonical}:${nonce}`,crypto.createHash('sha256').update(message).digest('hex'),'EX',300,'NX'); return {message,nonce,expiresIn:300};
}
export async function consumeNonce(redis:Redis,wallet:string,message:string,signature:string){
 const canonical=walletKey(wallet); const nonce=/^Nonce: (.+)$/m.exec(message)?.[1]; if(!nonce) return false;
 const key=`nonce:${canonical}:${nonce}`; const expected=await redis.getdel(key); if(!expected) return false;
 if(crypto.createHash('sha256').update(message).digest('hex')!==expected) return false;
 try{return nacl.sign.detached.verify(new TextEncoder().encode(message),bs58.decode(signature),new PublicKey(canonical).toBytes())}catch{return false}
}
export async function issueSession(redis:Redis,reply:FastifyReply,session:Session){
 const token=crypto.randomBytes(32).toString('base64url'); await redis.set(`session:${token}`,JSON.stringify(session),'EX',config.SESSION_TTL_SECONDS);
 reply.setCookie(config.SESSION_COOKIE_NAME,token,{httpOnly:true,secure:config.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:config.SESSION_TTL_SECONDS});
}
export async function requireSession(req:FastifyRequest,reply:FastifyReply,redis:Redis):Promise<Session|undefined>{
 const token=req.cookies[config.SESSION_COOKIE_NAME]; if(!token){reply.code(401).send({error:'authentication_required'});return}
 const raw=await redis.get(`session:${token}`); if(!raw){reply.code(401).send({error:'session_expired'});return}
 return JSON.parse(raw) as Session;
}
