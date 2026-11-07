import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Redis } from 'ioredis';
import { BookingStatus, PrismaClient, WorkspaceSessionStatus, ModerationStatus } from '@prisma/client';
const integration=process.env.DATABASE_URL&&process.env.REDIS_URL?test:test.skip;
process.env.NODE_ENV??='test';
process.env.SESSION_SECRET??='isolated-stopped-test-secret-0123456789';
process.env.INTERNAL_SERVICE_TOKEN??='isolated-stopped-test-token-0123456789';
process.env.PLATFORM_WALLET??='11111111111111111111111111111111';
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

integration('signed Agent stopped ACKs preserve terminal state and perform cleanup effects once',async t=>{
  const {registerWorkspaceGatewayRoutes}=await import('../src/workspace-gateway.js');
  const {seedReadySession}=await import('./fixtures/native-gateway-session.js');
  const db=new PrismaClient(),redis=new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:1});
  t.after(async()=>{redis.disconnect();await db.$disconnect();});
  for(const [name,delayedCleaned,winnerCleaned] of [
    ['duplicate success',true,true],['failure then late success',true,false],['success then late failure',false,true],['duplicate failure',false,false],
  ] as const){
    await t.test(name,async()=>{
      const fixture=await seedReadySession(db,crypto.randomBytes(8).toString('hex'),{bookingStatus:BookingStatus.ACTIVE,expectedSeconds:900,workspaceActivatedAt:new Date()});
      const pair=nacl.sign.keyPair();
      await db.machine.update({where:{id:fixture.machine.id},data:{agentPublicKey:bs58.encode(pair.publicKey)}});
      await db.workspaceSession.update({where:{id:fixture.session.id},data:{status:WorkspaceSessionStatus.RUNNING,startedAt:new Date()}});
      const entered=barrier(),release=barrier();let first=true;
      // Pause the first HTTP ACK immediately before starting its real DB tx.
      // On the vulnerable implementation its state has already been read.
      const wrapped=new Proxy(db,{get(target,key){
        if(key==='$transaction')return async(...args:unknown[])=>{
          if(first){first=false;entered.resolve();await release.promise;}
          return (db.$transaction as (...args:unknown[])=>Promise<unknown>)(...args);
        };
        return Reflect.get(target,key);
      }});
      const app=Fastify();await app.register(cookie);
      app.addHook('preParsing',(request,_reply,payload,done)=>{
        const chunks:Buffer[]=[];const capture=new Transform({transform(chunk:Buffer,_encoding,next){chunks.push(Buffer.from(chunk));next(null,chunk);}});
        capture.once('end',()=>{(request as {rawBody?:Buffer}).rawBody=Buffer.concat(chunks);});done(null,payload.pipe(capture as never));
      });
      registerWorkspaceGatewayRoutes(app,wrapped,redis);await app.ready();
      const route=`/agent/workspace-gateway/${fixture.session.id}/stopped`;
      const send=(cleaned:boolean)=>{
        const payload=Buffer.from(JSON.stringify({machineId:fixture.machine.id,cleaned}));
        const timestamp=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex'),digest=crypto.createHash('sha256').update(payload).digest('hex');
        const canonical=`POST|${route}|${fixture.machine.id}|${timestamp}|${nonce}|${digest}`;
        return app.inject({method:'POST',url:route,payload,headers:{'content-type':'application/json','x-agent-signature-version':'2',
          'x-agent-timestamp':timestamp,'x-agent-nonce':nonce,'x-agent-body-sha256':digest,
          'x-agent-signature-v2':bs58.encode(nacl.sign.detached(new TextEncoder().encode(canonical),pair.secretKey))}});
      };
      let pending:ReturnType<typeof send>|undefined;
      try{
        pending=send(delayedCleaned);await entered.promise;
        const winner=await send(winnerCleaned);
        assert.equal(winner.statusCode,winnerCleaned?200:409);
        const before=await db.workspaceSession.findUniqueOrThrow({where:{id:fixture.session.id}});
        const historyBefore=await db.machineQuarantineEvent.count({where:{machineId:fixture.machine.id}});
        release.resolve();const loser=await pending;
        assert.equal(loser.statusCode,winnerCleaned&&delayedCleaned?200:409);
        const after=await db.workspaceSession.findUniqueOrThrow({where:{id:fixture.session.id}});
        assert.equal(after.status,winnerCleaned?WorkspaceSessionStatus.COMPLETED:WorkspaceSessionStatus.QUARANTINED,'terminal winner cannot be rewritten');
        assert.deepEqual(after.endedAt,before.endedAt,'late ACK cannot rewrite end time');
        assert.equal(await db.workspaceSessionEvent.count({where:{sessionId:fixture.session.id,action:'GATEWAY_CLEANUP_VERIFIED'}}),winnerCleaned?1:0);
        assert.equal(await db.machineQuarantineEvent.count({where:{machineId:fixture.machine.id}}),historyBefore,'no duplicate quarantine side effects');
        assert.equal((await db.machine.findUniqueOrThrow({where:{id:fixture.machine.id}})).moderationStatus,winnerCleaned?ModerationStatus.CLEAR:ModerationStatus.QUARANTINED);
      }finally{
        release.resolve();await pending?.catch(()=>undefined);await app.close();
        await db.machineQuarantineEvent.deleteMany({where:{machineId:fixture.machine.id}});await fixture.cleanup();
      }
    });
  }
});
