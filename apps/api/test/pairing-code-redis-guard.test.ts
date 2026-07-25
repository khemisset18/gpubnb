import test from 'node:test';
import assert from 'node:assert/strict';
import {
 installPairingCodeRedisGuard,
 LINK_PREFIX,
 OWNER_PREFIX,
 type GuardedRedisClient,
 type GuardedRedisPrototype,
} from '../src/pairing-code-redis-guard.js';

class FakeRedis implements GuardedRedisClient{
 readonly values=new Map<string,string>();
 readonly ttls=new Map<string,number>();

 async set(...args:unknown[]):Promise<unknown>{
  const [key,value]=args;
  assert.equal(typeof key,'string');
  assert.equal(typeof value,'string');
  this.values.set(key,value);
  return 'OK';
 }

 async getdel(key:string):Promise<unknown>{
  const value=this.values.get(key)??null;
  this.values.delete(key);
  return value;
 }

 async eval(_script:string,numKeys:number,...args:string[]):Promise<unknown>{
  if(numKeys===2){
   const [ownerKey,linkKey,linkPrefix,ownerId,ttlRaw,digest]=args;
   const oldDigest=this.values.get(ownerKey);
   if(oldDigest)this.values.delete(`${linkPrefix}${oldDigest}`);
   if(this.values.has(linkKey))return null;
   this.values.set(linkKey,ownerId);
   this.values.set(ownerKey,digest);
   const ttl=Number(ttlRaw);
   this.ttls.set(linkKey,ttl);
   this.ttls.set(ownerKey,ttl);
   return 'OK';
  }
  if(numKeys===1){
   const [linkKey,ownerPrefix,digest]=args;
   const ownerId=this.values.get(linkKey);
   if(!ownerId)return null;
   this.values.delete(linkKey);
   const ownerKey=`${ownerPrefix}${ownerId}`;
   if(this.values.get(ownerKey)===digest)this.values.delete(ownerKey);
   return ownerId;
  }
  throw new Error(`Unexpected key count: ${numKeys}`);
 }
}

installPairingCodeRedisGuard(FakeRedis.prototype as unknown as GuardedRedisPrototype);

const digest=(character:string)=>character.repeat(64);

test('a new pairing code immediately invalidates the previous code for the same host',async()=>{
 const redis=new FakeRedis();
 const first=digest('a');
 const second=digest('b');
 await redis.set(`${LINK_PREFIX}${first}`,'host-1','EX',600,'NX');
 await redis.set(`${LINK_PREFIX}${second}`,'host-1','EX',600,'NX');
 assert.equal(redis.values.has(`${LINK_PREFIX}${first}`),false);
 assert.equal(redis.values.get(`${LINK_PREFIX}${second}`),'host-1');
 assert.equal(redis.values.get(`${OWNER_PREFIX}host-1`),second);
 assert.equal(redis.ttls.get(`${LINK_PREFIX}${second}`),600);
 assert.equal(redis.ttls.get(`${OWNER_PREFIX}host-1`),600);
});

test('concurrent requests leave exactly one active code for a host',async()=>{
 const redis=new FakeRedis();
 const first=digest('1');
 const second=digest('2');
 await Promise.all([
  redis.set(`${LINK_PREFIX}${first}`,'host-race','EX',600,'NX'),
  redis.set(`${LINK_PREFIX}${second}`,'host-race','EX',600,'NX'),
 ]);
 const active=[first,second].filter(value=>redis.values.has(`${LINK_PREFIX}${value}`));
 assert.equal(active.length,1);
 assert.equal(redis.values.get(`${OWNER_PREFIX}host-race`),active[0]);
});

test('a pairing code can only be consumed once and clears the host reference',async()=>{
 const redis=new FakeRedis();
 const codeDigest=digest('c');
 const key=`${LINK_PREFIX}${codeDigest}`;
 await redis.set(key,'host-2','EX',600,'NX');
 assert.equal(await redis.getdel(key),'host-2');
 assert.equal(await redis.getdel(key),null);
 assert.equal(redis.values.has(`${OWNER_PREFIX}host-2`),false);
});

test('pairing codes remain isolated between different hosts',async()=>{
 const redis=new FakeRedis();
 const first=digest('d');
 const second=digest('e');
 await redis.set(`${LINK_PREFIX}${first}`,'host-1','EX',600,'NX');
 await redis.set(`${LINK_PREFIX}${second}`,'host-2','EX',600,'NX');
 assert.equal(await redis.getdel(`${LINK_PREFIX}${first}`),'host-1');
 assert.equal(await redis.getdel(`${LINK_PREFIX}${second}`),'host-2');
});

test('unrelated Redis keys keep their original behavior',async()=>{
 const redis=new FakeRedis();
 await redis.set('session:example','value','EX',60);
 assert.equal(redis.values.get('session:example'),'value');
 assert.equal(await redis.getdel('session:example'),'value');
});

test('installing the guard twice is idempotent',async()=>{
 installPairingCodeRedisGuard(FakeRedis.prototype as unknown as GuardedRedisPrototype);
 const redis=new FakeRedis();
 const codeDigest=digest('f');
 await redis.set(`${LINK_PREFIX}${codeDigest}`,'host-3','EX',600,'NX');
 assert.equal(await redis.getdel(`${LINK_PREFIX}${codeDigest}`),'host-3');
});
