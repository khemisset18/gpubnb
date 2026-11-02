import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Redis } from 'ioredis';
import { BookingStatus, PrismaClient, WorkspaceSessionStatus } from '@prisma/client';

const integration=process.env.DATABASE_URL&&process.env.REDIS_URL?test:test.skip;
process.env.NODE_ENV??='test';
process.env.SESSION_SECRET??='isolated-test-session-secret-0123456789';
process.env.INTERNAL_SERVICE_TOKEN??='isolated-test-internal-token-0123456789';
process.env.PLATFORM_WALLET??='11111111111111111111111111111111';
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function signed(route:string,machineId:string,pair:nacl.SignKeyPair,body:unknown){
  const payload=Buffer.from(JSON.stringify(body)),timestamp=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex');
  const digest=crypto.createHash('sha256').update(payload).digest('hex');
  const canonical=`POST|${route}|${machineId}|${timestamp}|${nonce}|${digest}`;
  return {payload,headers:{'content-type':'application/json','x-agent-signature-version':'2','x-agent-timestamp':timestamp,
    'x-agent-nonce':nonce,'x-agent-body-sha256':digest,'x-agent-signature-v2':bs58.encode(nacl.sign.detached(new TextEncoder().encode(canonical),pair.secretKey))}};
}

integration('real endpoint first-frame billing: Redis refusal never commits paid time; accepted frames wait for a durable receipt',async t=>{
  const {registerWorkspaceGatewayRoutes,committedGatewayFrame}=await import('../src/workspace-gateway.js');
  const {seedReadySession}=await import('./fixtures/native-gateway-session.js');
  const db=new PrismaClient(),redis=new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:1});
  t.after(async()=>{redis.disconnect();await db.$disconnect();});
  for(const batch of [false,true]){
    for(const scenario of ['full','closed','cookie','db-stop','expired','db-failure','compensation-failure','positive','concurrent','lost-commit-ack'] as const){
      await t.test(`${batch?'ws-frames':'ws-frame'} / ${scenario}`,async()=>{
        const fixture=await seedReadySession(db,crypto.randomBytes(8).toString('hex'),{bookingStatus:BookingStatus.STARTING,expectedSeconds:900});
        const pair=nacl.sign.keyPair();
        await db.machine.update({where:{id:fixture.machine.id},data:{agentPublicKey:bs58.encode(pair.publicKey)}});
        const channelId=crypto.randomUUID(),browserKey='gpubnb:test:first-frame:'+channelId;
        const channelKey='workspace-gateway:ws-channel:'+channelId,queueKey='workspace-gateway:ws-input:'+channelId,bytesKey='workspace-gateway:ws-input-bytes:'+channelId;
        const activationKey='workspace-gateway:ws-session-activated:'+fixture.session.id,readyKey='workspace-gateway:ws-upstream-ready:'+channelId;
        const binding=JSON.stringify({sessionId:fixture.session.id,machineId:fixture.machine.id,browserSessionKey:browserKey,runtimeBackend:'WINDOWS_NATIVE'});
        const seen:string[]=[];
        await redis.set(channelKey,binding,'EX',120);await redis.set(browserKey,JSON.stringify({sessionId:fixture.session.id,userId:fixture.renter.id}),'EX',120);
        const originalEval=redis.eval.bind(redis);
        let gate:ReturnType<typeof barrier>|undefined,entered:ReturnType<typeof barrier>|undefined;
        let queuedBeforeCommit:string|undefined;
        if(scenario==='db-stop')await db.workspaceSession.update({where:{id:fixture.session.id},data:{status:WorkspaceSessionStatus.STOP_REQUESTED}});
        if(scenario==='expired')await db.workspaceSession.update({where:{id:fixture.session.id},data:{expiresAt:new Date(0)}});
        if(scenario==='full')await redis.lpush(queueKey,...Array(512).fill('fixture-filler'));
        if(scenario==='closed'||scenario==='cookie'){gate=barrier();entered=barrier();}
        redis.eval=(async(script:unknown,...args:unknown[])=>{
          const text=String(script);
          if(text.includes('Fence the channel binding')||text.includes('binding and enqueue are linearized')){
            if(entered){entered.resolve();await gate!.promise;}
            const result=await (originalEval as (...args:unknown[])=>Promise<unknown>)(script,...args);
            if(Number(result)===1&&scenario==='positive'){
              queuedBeforeCommit=(await redis.lrange(queueKey,0,0))[0];assert.ok(queuedBeforeCommit);
              assert.equal(await committedGatewayFrame(db,fixture.session.id,channelId,binding,queuedBeforeCommit),false,'uncommitted first frame is not deliverable');
            }
            return result;
          }
          if(text.includes('Remove only the exact payload')&&scenario==='compensation-failure')throw new Error('injected Redis cleanup outage');
          return (originalEval as (...args:unknown[])=>Promise<unknown>)(script,...args);
        }) as typeof redis.eval;
        const faultDb=new Proxy(db,{get(target,key){
          if(key==='$transaction'&&['db-failure','compensation-failure','lost-commit-ack'].includes(scenario))return async(callback:(tx:unknown)=>Promise<unknown>,options:unknown)=>{
            const result=await db.$transaction(async tx=>callback(new Proxy(tx,{get(inner,property){
              if(property==='workspaceGatewayAcceptance'&&scenario!=='lost-commit-ack')return new Proxy(tx.workspaceGatewayAcceptance,{get(model,method){if(method==='create')return async()=>{throw new Error('injected receipt write failure');};return Reflect.get(model,method);}});
              return Reflect.get(inner,property);
            }})) as never,options as never);
            if(scenario==='lost-commit-ack')throw new Error('injected lost DB commit acknowledgement');
            return result;
          };
          return Reflect.get(target,key);
        }});
        const app=Fastify();await app.register(cookie);
        app.addHook('preParsing',(request,_reply,payload,done)=>{
          const chunks:Buffer[]=[];
          const capture=new Transform({transform(chunk:Buffer,_encoding,next){chunks.push(Buffer.from(chunk));next(null,chunk);}});
          capture.once('end',()=>{(request as {rawBody?:Buffer}).rawBody=Buffer.concat(chunks);});done(null,payload.pipe(capture as never));
        });
        registerWorkspaceGatewayRoutes(app,faultDb,redis);await app.ready();
        const route='/agent/workspace-gateway/'+(batch?'ws-frames':'ws-frame');
        const send=()=>{
          const frame={channelId,frameId:crypto.randomUUID(),dataBase64:'AA==',binary:true};
          seen.push('workspace-gateway:ws-frame-seen:'+fixture.machine.id+':'+frame.frameId);
          return app.inject({method:'POST',url:route,...signed(route,fixture.machine.id,pair,batch?{machineId:fixture.machine.id,frames:[frame]}:{machineId:fixture.machine.id,...frame})});
        };
        try{
          const responses=scenario==='concurrent'?await Promise.all([send(),send(),send(),send()]):await(async()=>{
            const pending=send();if(entered){await entered.promise;await redis.del(scenario==='closed'?channelKey:browserKey);gate!.resolve();}return [await pending];
          })();
          const session=await db.workspaceSession.findUniqueOrThrow({where:{id:fixture.session.id}});
          const booking=await db.booking.findUniqueOrThrow({where:{id:fixture.booking.id}});
          const receipts=await db.workspaceGatewayAcceptance.count({where:{sessionId:fixture.session.id}});
          const events=await db.workspaceSessionEvent.count({where:{sessionId:fixture.session.id,action:'INTERACTIVE_WORKSPACE_CONNECTED'}});
          if(!['positive','concurrent','lost-commit-ack'].includes(scenario)){
            assert.equal(session.startedAt,null,'no paid start when first acceptance/commit failed');
            assert.equal(booking.workspaceActivatedAt,null);assert.equal(booking.status,BookingStatus.STARTING);
            assert.equal(session.status,scenario==='db-stop'?WorkspaceSessionStatus.STOP_REQUESTED:WorkspaceSessionStatus.READY);assert.equal(receipts,0);assert.equal(events,0);
            assert.deepEqual(booking.startsAt,fixture.booking.startsAt);assert.deepEqual(booking.endsAt,fixture.booking.endsAt);
            if(scenario==='full')assert.ok(responses.every(r=>r.statusCode===429));
            if(['closed','cookie','db-stop','expired'].includes(scenario))assert.ok(responses.every(r=>batch?r.json().stale===1:r.statusCode===409));
            if(scenario==='db-failure'){
              assert.equal(await redis.llen(queueKey),0);assert.equal(Number(await redis.get(bytesKey)??'0'),0);
              for(const marker of seen)assert.equal(await redis.exists(marker),0);
            }
            if(scenario==='compensation-failure'){
              const orphan=(await redis.lrange(queueKey,0,0))[0];assert.ok(orphan);
              assert.equal(await committedGatewayFrame(db,fixture.session.id,channelId,binding,orphan),false,'orphan cannot deliver despite cleanup outage');
            }
          }else{
            assert.ok(responses.every(r=>r.statusCode===200));assert.ok(session.startedAt);assert.ok(booking.workspaceActivatedAt);
            assert.equal(receipts,1);assert.equal(events,1,'concurrent contenders activate once');
            const queued=await redis.lrange(queueKey,0,-1),first=queued.find(raw=>JSON.parse(raw).activationReceiptId);assert.ok(first);
            assert.equal(await committedGatewayFrame(db,fixture.session.id,channelId,binding,first),true);
            await assert.rejects(committedGatewayFrame(db,fixture.session.id,channelId,binding,JSON.stringify({...JSON.parse(first),dataBase64:'AQ=='})),/receipt_mismatch/);
            if(queuedBeforeCommit)assert.equal(queuedBeforeCommit,first);
          }
        }finally{redis.eval=originalEval as typeof redis.eval;await app.close();await redis.del(channelKey,browserKey,queueKey,bytesKey,activationKey,readyKey,...seen);await fixture.cleanup();}
      });
    }
  }
});
