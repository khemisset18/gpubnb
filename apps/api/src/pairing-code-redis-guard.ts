import { Redis } from 'ioredis';

const LINK_PREFIX='machine-link:';
const OWNER_PREFIX='machine-link-owner:';
const INSTALL_MARK=Symbol.for('gpubnb.pairing-code-redis-guard');

type GuardedRedisPrototype={
 [INSTALL_MARK]?:boolean;
 set:(this:Redis,...args:unknown[])=>Promise<unknown>;
 getdel:(this:Redis,key:string)=>Promise<unknown>;
};

const prototype=Redis.prototype as unknown as GuardedRedisPrototype;

if(!prototype[INSTALL_MARK]){
 const originalSet=prototype.set;
 const originalGetdel=prototype.getdel;

 prototype.set=async function(this:Redis,...args:unknown[]):Promise<unknown>{
  const [key,value,...options]=args;
  if(typeof key!== 'string'||!key.startsWith(LINK_PREFIX)||typeof value!=='string')return originalSet.apply(this,args);
  const digest=key.slice(LINK_PREFIX.length);
  if(!/^[a-f0-9]{64}$/.test(digest))return originalSet.apply(this,args);
  const exIndex=options.findIndex(option=>String(option).toUpperCase()==='EX');
  const ttl=exIndex>=0?Number(options[exIndex+1]):0;
  const usesNx=options.some(option=>String(option).toUpperCase()==='NX');
  if(!Number.isInteger(ttl)||ttl<1||!usesNx)return originalSet.apply(this,args);
  const ownerKey=`${OWNER_PREFIX}${value}`;
  return this.eval(
   "local old=redis.call('GET',KEYS[1]); if old then redis.call('DEL',ARGV[1]..old) end; local created=redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3],'NX'); if not created then return false end; redis.call('SET',KEYS[1],ARGV[4],'EX',ARGV[3]); return created",
   2,
   ownerKey,
   key,
   LINK_PREFIX,
   value,
   String(ttl),
   digest,
  );
 };

 prototype.getdel=async function(this:Redis,key:string):Promise<unknown>{
  if(typeof key!=='string'||!key.startsWith(LINK_PREFIX))return originalGetdel.call(this,key);
  const digest=key.slice(LINK_PREFIX.length);
  if(!/^[a-f0-9]{64}$/.test(digest))return originalGetdel.call(this,key);
  return this.eval(
   "local owner=redis.call('GET',KEYS[1]); if not owner then return false end; redis.call('DEL',KEYS[1]); local ownerKey=ARGV[1]..owner; if redis.call('GET',ownerKey)==ARGV[2] then redis.call('DEL',ownerKey) end; return owner",
   1,
   key,
   OWNER_PREFIX,
   digest,
  );
 };

 prototype[INSTALL_MARK]=true;
}
