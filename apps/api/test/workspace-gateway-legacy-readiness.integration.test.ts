import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {BookingStatus, PrismaClient} from '@prisma/client';
import {Redis} from 'ioredis';

const integration=process.env.DATABASE_URL&&process.env.REDIS_URL?test:test.skip;
process.env.NODE_ENV??='test';
process.env.SESSION_SECRET??='isolated-test-session-secret-0123456789';
process.env.INTERNAL_SERVICE_TOKEN??='isolated-test-internal-token-0123456789';
process.env.PLATFORM_WALLET??='11111111111111111111111111111111';

integration('legacy second channel publishes readiness on a hot shared generation without SQL or TTL extension',async()=>{
  const {acceptGatewayFrame,markAcceptedGatewayFrame}=await import('../src/workspace-gateway.js');
  const {seedReadySession}=await import('./fixtures/native-gateway-session.js');
  const db=new PrismaClient({log:[{emit:'event',level:'query'}]});
  const redis=new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:1});
  let sql=0;db.$on('query',()=>{sql++;});
  const fixture=await seedReadySession(db,crypto.randomBytes(8).toString('hex'),{bookingStatus:BookingStatus.STARTING,expectedSeconds:900});
  const sessionId=fixture.session.id,machineId=fixture.machine.id;
  const authorityKey='workspace-gateway:ws-session-activated:'+sessionId;
  const keys=[authorityKey];
  try{
    // Legacy code-server Agents use CONTAINER and may send a signed frame
    // without a ws_open response; both channels share one session generation.
    await db.workspaceSession.delete({where:{id:sessionId}});
    await db.workspaceSession.create({data:{
      id:sessionId,bookingId:fixture.booking.id,renterId:fixture.renter.id,machineId,
      machineWorkspaceId:fixture.session.machineWorkspaceId,jobId:fixture.session.jobId,
      status:'READY',runtimeBackend:'CONTAINER',isolationType:'DOCKER',
      resourceLimits:{maxRamMiB:4096},connectionType:'GPUBNB_GATEWAY',
      readyAt:new Date(),expiresAt:fixture.session.expiresAt,
    }});
    const channels=await Promise.all([0,1].map(async()=>{
      const channelId=crypto.randomUUID(),browserSessionKey='gpubnb:test:legacy-browser:'+channelId;
      const channelKey='workspace-gateway:ws-channel:'+channelId,readyKey='workspace-gateway:ws-upstream-ready:'+channelId;
      const binding={sessionId,machineId,browserSessionKey,runtimeBackend:'CONTAINER' as const};
      const bindingRaw=JSON.stringify(binding);
      keys.push(browserSessionKey,channelKey,readyKey,'workspace-gateway:ws-input:'+channelId,'workspace-gateway:ws-input-bytes:'+channelId);
      await redis.set(browserSessionKey,JSON.stringify({sessionId,userId:fixture.renter.id}),'PX',30_000);
      await redis.set(channelKey,bindingRaw,'PX',20_000);
      return {channelId,binding,bindingRaw,channelKey,readyKey};
    }));
    const frame={dataBase64:'AA==',binary:true,close:false};
    const first=await acceptGatewayFrame({db,redis,sessionId,machineId,...channels[0]!,frame});
    assert.equal(first.enqueued,1);assert.ok(first.expiresAt);
    assert.equal(await markAcceptedGatewayFrame(redis,sessionId,channels[0]!.channelId,channels[0]!.binding,first.authorityId,first.expiresAt),true);
    assert.equal(await redis.get(channels[0]!.readyKey),'1','database-backed first activation still publishes readiness');
    const second=channels[1]!;
    const before=await Promise.all([authorityKey,second.channelKey,second.binding.browserSessionKey].map(key=>redis.pttl(key)));
    sql=0;
    for(let index=0;index<3;index++){
      const accepted=await acceptGatewayFrame({db,redis,sessionId,machineId,...second,frame});
      assert.equal(accepted.enqueued,1);
      assert.equal(accepted.expiresAt,undefined,'second channel uses the shared Redis-only generation');
      assert.equal(await markAcceptedGatewayFrame(redis,sessionId,second.channelId,second.binding,accepted.authorityId,accepted.expiresAt),true);
      assert.equal(await redis.get(second.readyKey),'1','the legacy upstream probe must observe a ready marker');
    }
    assert.equal(sql,0,'hot admission plus readiness must perform no SQL');
    const after=await Promise.all([authorityKey,second.channelKey,second.binding.browserSessionKey].map(key=>redis.pttl(key)));
    after.forEach((ttl,index)=>assert.ok(ttl>0&&ttl<=before[index]!,`TTL ${index} must only decrease`));
    assert.ok(await redis.pttl(second.readyKey)<=Math.min(after[1]!,after[2]!));
    assert.equal(await db.workspaceGatewayAcceptance.count({where:{sessionId}}),1,'the second channel cannot bill again');
  }finally{
    await redis.del(...keys);redis.disconnect();await fixture.cleanup();await db.$disconnect();
  }
});

test('hot readiness fails closed on STOP, binding replacement, and absent or unbounded TTLs',{skip:!process.env.REDIS_URL},async t=>{
  const {markAcceptedGatewayFrame,revokeGatewayAuthority}=await import('../src/workspace-gateway.js');
  const redis=new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:1});
  try{
    for(const scenario of ['stop','replaced','missing-channel','missing-browser','persistent-channel','persistent-browser'] as const){
      await t.test(scenario,async()=>{
        const sessionId=crypto.randomUUID(),channelId=crypto.randomUUID(),receipt=crypto.randomUUID();
        const browserSessionKey='gpubnb:test:legacy-browser:'+channelId;
        const authorityKey='workspace-gateway:ws-session-activated:'+sessionId,channelKey='workspace-gateway:ws-channel:'+channelId,readyKey='workspace-gateway:ws-upstream-ready:'+channelId;
        const binding={sessionId,machineId:'machine',browserSessionKey,runtimeBackend:'CONTAINER' as const};
        try{
          await redis.set(authorityKey,receipt,'PX',2000);
          await redis.set(channelKey,JSON.stringify(binding),'PX',20_000);
          await redis.set(browserSessionKey,'live','PX',30_000);
          if(scenario==='stop')await revokeGatewayAuthority(redis,sessionId);
          if(scenario==='replaced')await redis.set(channelKey,JSON.stringify({...binding,machineId:'replacement'}),'PX',20_000);
          if(scenario==='missing-channel')await redis.del(channelKey);
          if(scenario==='missing-browser')await redis.del(browserSessionKey);
          if(scenario==='persistent-channel')await redis.persist(channelKey);
          if(scenario==='persistent-browser')await redis.persist(browserSessionKey);
          assert.equal(await markAcceptedGatewayFrame(redis,sessionId,channelId,binding,receipt),false);
          assert.equal(await redis.get(readyKey),null);
          if(scenario==='stop')assert.match((await redis.get(authorityKey))!,/^revoked:/);
        }finally{await redis.del(authorityKey,channelKey,browserSessionKey,readyKey);}
      });
    }
  }finally{redis.disconnect();}
});

integration('real browser sockets accept modern ws_open ACK and legacy first-frame readiness on a second channel',async()=>{
  const {default:Fastify}=await import('fastify');
  const {default:cookie}=await import('@fastify/cookie');
  const {default:WebSocket}=await import('ws');
  const {default:bs58}=await import('bs58');
  const {default:nacl}=await import('tweetnacl');
  const {Transform}=await import('node:stream');
  const {once}=await import('node:events');
  const {registerWorkspaceGatewayRoutes}=await import('../src/workspace-gateway.js');
  const {seedReadySession}=await import('./fixtures/native-gateway-session.js');
  const db=new PrismaClient(),redis=new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:1});
  const fixture=await seedReadySession(db,crypto.randomBytes(8).toString('hex'),{bookingStatus:BookingStatus.STARTING,expectedSeconds:900});
  const pair=nacl.sign.keyPair(),sessionId=fixture.session.id,machineId=fixture.machine.id;
  const browserToken=crypto.randomBytes(32).toString('hex');
  const browserKey='workspace-gateway-session:'+crypto.createHash('sha256').update(browserToken).digest('hex');
  const queueKey='workspace-gateway:machine:'+machineId;
  const keys=[browserKey,queueKey,'workspace-gateway:machine-bytes:'+machineId,'workspace-gateway:ws-session-activated:'+sessionId];
  const sockets:InstanceType<typeof WebSocket>[]=[];
  const app=Fastify();await app.register(cookie);
  app.addHook('preParsing',(request,_reply,payload,done)=>{
    const chunks:Buffer[]=[];
    const capture=new Transform({transform(chunk:Buffer,_encoding,next){chunks.push(Buffer.from(chunk));next(null,chunk);}});
    capture.once('end',()=>{(request as {rawBody?:Buffer}).rawBody=Buffer.concat(chunks);});
    done(null,payload.pipe(capture as never));
  });
  async function agentPost(route:string,body:unknown){
    const payload=Buffer.from(JSON.stringify(body)),timestamp=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex');
    const digest=crypto.createHash('sha256').update(payload).digest('hex');
    const canonical=`POST|${route}|${machineId}|${timestamp}|${nonce}|${digest}`;
    const response=await app.inject({method:'POST',url:route,payload,headers:{
      'content-type':'application/json','x-agent-signature-version':'2','x-agent-timestamp':timestamp,
      'x-agent-nonce':nonce,'x-agent-body-sha256':digest,
      'x-agent-signature-v2':bs58.encode(nacl.sign.detached(new TextEncoder().encode(canonical),pair.secretKey)),
    }});
    assert.equal(response.statusCode,200,response.body);
  }
  try{
    await db.machine.update({where:{id:machineId},data:{agentPublicKey:bs58.encode(pair.publicKey)}});
    await db.workspaceSession.delete({where:{id:sessionId}});
    await db.workspaceSession.create({data:{id:sessionId,bookingId:fixture.booking.id,renterId:fixture.renter.id,machineId,
      machineWorkspaceId:fixture.session.machineWorkspaceId,jobId:fixture.session.jobId,status:'READY',runtimeBackend:'CONTAINER',
      isolationType:'DOCKER',resourceLimits:{maxRamMiB:4096},connectionType:'GPUBNB_GATEWAY',readyAt:new Date(),expiresAt:fixture.session.expiresAt}});
    await redis.set(browserKey,JSON.stringify({sessionId,userId:fixture.renter.id}),'EX',120);
    registerWorkspaceGatewayRoutes(app,db,redis);
    const address=await app.listen({host:'127.0.0.1',port:0});
    for(const modern of [true,false]){
      const ws=new WebSocket(address.replace('http:','ws:')+`/workspace-gateway/${sessionId}/`,{headers:{cookie:`gpubnb_workspace=${browserToken}`}});
      sockets.push(ws);await once(ws,'open',{signal:AbortSignal.timeout(5000)});
      let relay:{id:string;channelId:string}|undefined;
      const deadline=Date.now()+5000;
      while(!relay&&Date.now()<deadline){
        const raw=await redis.rpop(queueKey);
        if(raw){const candidate=JSON.parse(raw);if(candidate.kind==='ws_open')relay=candidate;}
        if(!relay)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(relay,'browser upgrade must enqueue the real Agent ws_open request');
      keys.push('workspace-gateway:response:'+relay.id,'workspace-gateway:ws-channel:'+relay.channelId,
        'workspace-gateway:ws-upstream-ready:'+relay.channelId,'workspace-gateway:ws-input:'+relay.channelId,'workspace-gateway:ws-input-bytes:'+relay.channelId);
      if(modern)await agentPost('/agent/workspace-gateway/respond',{machineId,id:relay.id,status:101});
      // Old compatible Agents deliberately omit /respond. Both Agent versions
      // send a real signed API frame, which must reach the browser socket.
      const received=once(ws,'message',{signal:AbortSignal.timeout(5000)});
      const value=modern?'modern-frame':'legacy-frame';
      await agentPost('/agent/workspace-gateway/ws-frame',{machineId,channelId:relay.channelId,dataBase64:Buffer.from(value).toString('base64'),binary:true});
      assert.equal((await received)[0].toString(),value);
      assert.equal(await redis.get('workspace-gateway:ws-upstream-ready:'+relay.channelId),'1');
    }
    // Exercise the actual 15-second legacy ws_open probe, not just Redis state.
    await new Promise(resolve=>setTimeout(resolve,15_500));
    for(const ws of sockets)assert.equal(ws.readyState,WebSocket.OPEN,'neither supported Agent mode may close 1011 after its open probe');
    assert.equal(await db.workspaceGatewayAcceptance.count({where:{sessionId}}),1);
  }finally{
    for(const ws of sockets)ws.terminate();
    await app.close();await redis.del(...keys);redis.disconnect();await fixture.cleanup();await db.$disconnect();
  }
});
