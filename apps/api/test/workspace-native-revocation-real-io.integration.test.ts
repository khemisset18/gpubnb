import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { BookingStatus, PrismaClient, WorkspaceRuntimeBackend, WorkspaceSessionStatus } from '@prisma/client';
import { Redis } from 'ioredis';
import { createGatewayChannelLeaseGuard } from '../src/workspace-gateway-channel-lease.js';

const integration = process.env.REDIS_URL && process.env.DATABASE_URL ? test : test.skip;
// Only ephemeral test services may run this suite. Never supply production URLs.
process.env.NODE_ENV ??= 'test';
process.env.SESSION_SECRET ??= 'isolated-test-session-secret-0123456789';
process.env.INTERNAL_SERVICE_TOKEN ??= 'isolated-test-internal-token-0123456789';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';
function percentile(sorted: number[], p: number) {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

// The production queued-relay authorization path over seeded native sessions.
// This is a one-second paced admission workload, not encoded
// video, a saturation test, or a production SLO qualification.
integration('30/60 FPS x 1/4/8 streams: real session fence and Redis binding EVAL', async () => {
  const { activeGatewaySession, authorizeQueuedGatewayRelay } = await import('../src/workspace-gateway.js');
  const { seedReadySession } = await import('./fixtures/native-gateway-session.js');
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
  const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  let sqlQueries = 0;
  db.$on('query', () => { sqlQueries++; });
  const prefix = 'gpubnb:test:stage4:real-auth:' + crypto.randomUUID();
  const keys: string[] = [];
  const fixtures: Awaited<ReturnType<typeof seedReadySession>>[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      fixtures.push(await seedReadySession(db, crypto.randomBytes(8).toString('hex'), {
        bookingStatus: BookingStatus.STARTING, expectedSeconds: 900,
      }));
    }
    for (const fps of [30, 60] as const) {
      for (const channels of [1, 4, 8]) {
        let redisFences = 0;
        const samples: number[] = [];
        const frames = fps * channels;
        const before = performance.now(), cpuBefore = process.cpuUsage();
        const rssBefore = process.memoryUsage().rss;
        sqlQueries = 0;
        await Promise.all(fixtures.slice(0, channels).map(async (fixture, i) => {
          const sessionId = fixture.session.id, userId = fixture.renter.id;
          const browserKey = prefix + ':cookie:' + fps + ':' + channels + ':' + i;
          const channelId = crypto.randomUUID();
          const bindingKey = 'workspace-gateway:ws-channel:' + channelId;
          keys.push(browserKey);
          keys.push(bindingKey);
          const browserRaw = JSON.stringify({sessionId, userId});
          const bindingRaw = JSON.stringify({sessionId, machineId: fixture.machine.id, browserSessionKey: browserKey, runtimeBackend: 'WINDOWS_NATIVE'});
          await redis.set(browserKey, browserRaw, 'EX', 60);
          await redis.set(bindingKey, bindingRaw, 'EX', 60);
          const relay = {id:crypto.randomUUID(),sessionId,kind:'ws_send' as const,channelId,nativeChannelBinding:bindingRaw,dataBase64:'AA==',binary:true};
          const channelStart = performance.now();
          for (let frame = 0; frame < fps; frame++) {
            const started = performance.now();
            redisFences++;
            const accepted = await authorizeQueuedGatewayRelay(db,redis,fixture.machine.id,relay);
            assert.ok(accepted);
            samples.push(performance.now() - started);
            // Pace by the original deadline, so slow authorization is visible
            // in wall time instead of adding a full sleep after every query.
            const remaining = channelStart + (frame + 1) * 1000 / fps - performance.now();
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
          }
        }));
        assert.equal(redisFences, frames);
        assert.ok(sqlQueries >= frames, 'count the combined locked active-session predicate per frame');
        samples.sort((a, b) => a - b);
        const summary = {
          kind: 'ci-ephemeral-real-prisma-session-fence-plus-redis-eval-not-video-or-production',
          fps, channels, checkedFrames: frames, redisFences, sqlQueries,
          sqlQueriesPerFrame: sqlQueries / frames,
          p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99),
          wallMs: performance.now() - before, cpuMicroseconds: process.cpuUsage(cpuBefore),
          rssBefore, rssAfter: process.memoryUsage().rss,
          // Queue accounting, encoded video, browser TCP and Windows capture
          // remain outside this admission-only timing.
          includesEncodedVideoOrBrowserSocket: false,
        };
        assert.ok(summary.p50Ms >= 0 && summary.p95Ms >= summary.p50Ms && summary.p99Ms >= summary.p95Ms);
        console.log('STAGE4_NATIVE_REAL_AUTH ' + JSON.stringify(summary));
      }
    }
    const fixture = fixtures[0]!;
    const browserKey = prefix + ':revocation';
    keys.push(browserKey);
    await redis.set(browserKey, JSON.stringify({sessionId: fixture.session.id, userId: fixture.renter.id}), 'EX', 60);
    const channelId = crypto.randomUUID();
    const channelKey = 'workspace-gateway:ws-channel:' + channelId;
    keys.push(channelKey);
    const binding = JSON.stringify({sessionId:fixture.session.id,machineId:fixture.machine.id,browserSessionKey:browserKey,runtimeBackend:'WINDOWS_NATIVE'});
    await redis.set(channelKey,binding,'EX',60);
    const queued = {id:crypto.randomUUID(),sessionId:fixture.session.id,kind:'ws_send' as const,channelId,nativeChannelBinding:binding,dataBase64:'AA==',binary:true};
    const allowed = await authorizeQueuedGatewayRelay(db,redis,fixture.machine.id,queued);
    assert.ok(allowed, 'real DB and Redis authorize a current queued native input');
    assert.equal('nativeChannelBinding' in allowed,false);
    await redis.del(channelKey);
    assert.equal(await authorizeQueuedGatewayRelay(db,redis,fixture.machine.id,queued),null,'real Redis channel revocation discards buffered input');
    await redis.set(channelKey,binding,'EX',60);
    await redis.del(browserKey);
    assert.equal(await authorizeQueuedGatewayRelay(db,redis,fixture.machine.id,queued),null,'real Redis cookie revocation discards buffered input');
    await redis.set(browserKey,JSON.stringify({sessionId:fixture.session.id,userId:fixture.renter.id}),'EX',60);
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { entered = resolve; });
    let reads = 0;
    const guard = createGatewayChannelLeaseGuard({
      sessionId: fixture.session.id, userId: fixture.renter.id, cacheMs: 0,
      readBrowser: () => redis.get(browserKey),
      readWorkspace: async () => {
        const row = await activeGatewaySession(db, fixture.session.id);
        if (++reads === 1) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
        return row;
      },
    });
    const old = guard();
    await barrier;
    await db.workspaceSession.update({where: {id: fixture.session.id}, data: {status: WorkspaceSessionStatus.STOP_REQUESTED}});
    assert.equal(await guard(), false, 'a committed DB STOP denies the fresh check');
    assert.equal(await authorizeQueuedGatewayRelay(db,redis,fixture.machine.id,queued),null,'real PostgreSQL STOP discards buffered input even with live Redis keys');
    release();
    assert.equal(await old, false, 'known DB denial fences the older successful query');
    await db.workspaceSession.update({where: {id: fixture.session.id}, data: {status: WorkspaceSessionStatus.READY, expiresAt: new Date(0)}});
    assert.equal(await guard(), false, 'expired real workspace must deny');
  } finally {
    if(keys.length) await redis.del(...keys).catch(() => undefined);
    redis.disconnect();
    for (const fixture of fixtures.reverse()) await fixture.cleanup();
    await db.$disconnect();
  }
});

integration('30/60 FPS x 1/4/8 streams: real generation admission has zero hot-path SQL',async()=>{
  const {acceptGatewayFrame}=await import('../src/workspace-gateway.js');
  const {seedReadySession}=await import('./fixtures/native-gateway-session.js');
  const redis=new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:2});
  const db=new PrismaClient({log:[{emit:'event',level:'query'}]});
  let sqlQueries=0;db.$on('query',()=>{sqlQueries++;});
  const fixtures:Awaited<ReturnType<typeof seedReadySession>>[]=[];
  const keys:string[]=[],requests:Array<Parameters<typeof acceptGatewayFrame>[0]>=[];
  try{
    for(let i=0;i<8;i++){
      const fixture=await seedReadySession(db,crypto.randomBytes(8).toString('hex'),{bookingStatus:BookingStatus.STARTING,expectedSeconds:900});
      fixtures.push(fixture);
      const channelId=crypto.randomUUID(),browserKey=`gpubnb:test:generation-load:${crypto.randomUUID()}`;
      const channelKey='workspace-gateway:ws-channel:'+channelId;
      const bindingRaw=JSON.stringify({sessionId:fixture.session.id,machineId:fixture.machine.id,browserSessionKey:browserKey,runtimeBackend:'WINDOWS_NATIVE'});
      keys.push(channelKey,browserKey,'workspace-gateway:ws-session-activated:'+fixture.session.id,
        'workspace-gateway:ws-input:'+channelId,'workspace-gateway:ws-input-bytes:'+channelId);
      await redis.set(channelKey,bindingRaw,'EX',120);await redis.set(browserKey,'live','EX',120);
      const request={db,redis,sessionId:fixture.session.id,machineId:fixture.machine.id,channelId,bindingRaw,
        frame:{dataBase64:'AA==',binary:true,close:false}};
      requests.push(request);
      assert.equal((await acceptGatewayFrame(request)).enqueued,1,'the measured session must first commit billing and its receipt');
    }
    for(const fps of [30,60] as const)for(const channels of [1,4,8]){
      // Warm or renew each two-second receipt lease outside the measured region.
      await redis.del(...requests.slice(0,channels).map(request=>'workspace-gateway:ws-session-activated:'+request.sessionId));
      assert.deepEqual((await Promise.all(requests.slice(0,channels).map(acceptGatewayFrame))).map(x=>x.enqueued),Array(channels).fill(1));
      sqlQueries=0;const samples:number[]=[];const before=performance.now();
      await Promise.all(requests.slice(0,channels).map(async request=>{
        const channelStart=performance.now();
        for(let frame=0;frame<fps;frame++){
          const started=performance.now(),accepted=await acceptGatewayFrame(request);
          assert.equal(accepted.enqueued,1);samples.push(performance.now()-started);
          const remaining=channelStart+(frame+1)*1000/fps-performance.now();
          if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));
        }
      }));
      samples.sort((a,b)=>a-b);const frames=fps*channels;
      const summary={kind:'ci-ephemeral-real-redis-generation-admission-not-video-or-production',fps,channels,frames,
        sqlQueries,sqlQueriesPerFrame:sqlQueries/frames,redisGets:frames,redisEvals:frames,
        p50Ms:percentile(samples,.5),p95Ms:percentile(samples,.95),p99Ms:percentile(samples,.99),wallMs:performance.now()-before};
      assert.equal(sqlQueries,0,'a hot receipt lease must issue no Prisma query per frame');
      console.log('STAGE4_GENERATION_ADMISSION_REAL '+JSON.stringify(summary));
    }
  }finally{
    if(keys.length)await redis.del(...keys).catch(()=>undefined);redis.disconnect();
    for(const fixture of fixtures.reverse())await fixture.cleanup();await db.$disconnect();
  }
});

integration('PostgreSQL session row lock orders native send commits against STOP', async () => {
  const { markNativeGatewayRevocationStarted, withNativeGatewaySessionFence } = await import('../src/workspace-gateway.js');
  const { seedReadySession } = await import('./fixtures/native-gateway-session.js');
  const db = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
  const fixture = await seedReadySession(db, crypto.randomBytes(8).toString('hex'), {
    bookingStatus: BookingStatus.STARTING, expectedSeconds: 900,
  });
  const barrier = () => {
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    return { promise, open };
  };
  try {
    const entered = barrier(), release = barrier();
    let sendCommitted = false;
    const nativeSend = withNativeGatewaySessionFence(
      db, fixture.session.id, fixture.machine.id, fixture.renter.id, WorkspaceRuntimeBackend.WINDOWS_NATIVE,
      async () => { entered.open(); await release.promise; sendCommitted = true; return true; },
    );
    await entered.promise; // The native operation holds FOR SHARE now.
    let stopCommitted = false;
    const stop = markNativeGatewayRevocationStarted(
      db, redis, fixture.session.id, fixture.machine.id,
    ).then(value => { stopCommitted = value; return value; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(stopCommitted, false, 'STOP must wait while a previously admitted synchronous send reaches its commit point');
    release.open();
    assert.equal(await nativeSend, true);
    assert.equal(await stop,true);
    assert.equal(sendCommitted, true);
    assert.equal(stopCommitted, true);
    assert.equal((await db.workspaceSession.findUniqueOrThrow({where:{id:fixture.session.id}})).status,WorkspaceSessionStatus.STOPPING);
    let deniedPostRevokeSends=0;
    assert.equal(await withNativeGatewaySessionFence(
      db,fixture.session.id,fixture.machine.id,fixture.renter.id,WorkspaceRuntimeBackend.WINDOWS_NATIVE,
      async()=>{deniedPostRevokeSends++;return true;},
    ),false);
    assert.equal(deniedPostRevokeSends,0,'frames waiting after the committed WTS revocation must not reach Redis or ws.send');

    // Registration and usage mutate the session, so they take FOR UPDATE.
    // They must also serialize with STOP and run their writes in this same tx.
    await db.workspaceSession.update({where:{id:fixture.session.id},data:{status:WorkspaceSessionStatus.READY}});
    const mutationEntered=barrier(),releaseMutation=barrier();
    let mutationCommitted=false, mutationStopCommitted=false;
    const mutation=withNativeGatewaySessionFence(
      db,fixture.session.id,fixture.machine.id,fixture.renter.id,WorkspaceRuntimeBackend.WINDOWS_NATIVE,
      async (_isActive,tx)=>{
        await tx.workspaceSession.update({where:{id:fixture.session.id},data:{gatewayLastSeenAt:new Date()}});
        mutationEntered.open();
        await releaseMutation.promise;
        mutationCommitted=true;
        return true;
      },
      {lockSessionForMutation:true},
    );
    await mutationEntered.promise;
    const mutationStop=db.workspaceSession.update({
      where:{id:fixture.session.id},data:{status:WorkspaceSessionStatus.STOP_REQUESTED},
    }).then(value=>{mutationStopCommitted=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(mutationStopCommitted,false,'STOP must wait for an admitted native registration/usage mutation transaction');
    releaseMutation.open();
    assert.equal(await mutation,true);
    await mutationStop;
    assert.equal(mutationCommitted,true);
    assert.equal(mutationStopCommitted,true);

    // When STOP owns the row lock first, a frame waiting on FOR SHARE observes
    // the committed terminal status and never invokes its send callback.
    const stopLocked = barrier(), finishStop = barrier();
    const terminalFirst = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "id"=${fixture.session.id} FOR UPDATE`;
      await tx.workspaceSession.update({ where: { id: fixture.session.id }, data: { status: WorkspaceSessionStatus.COMPLETED } });
      stopLocked.open();
      await finishStop.promise;
    });
    await stopLocked.promise;
    let staleSendCalls = 0;
    const waitingSends = Array.from({ length: 4 }, () => withNativeGatewaySessionFence(
      db, fixture.session.id, fixture.machine.id, fixture.renter.id, WorkspaceRuntimeBackend.WINDOWS_NATIVE,
      async () => { staleSendCalls++; return true; },
    ));
    await new Promise(resolve => setTimeout(resolve, 25));
    finishStop.open();
    await terminalFirst;
    assert.deepEqual(await Promise.all(waitingSends), [false, false, false, false]);
    assert.equal(staleSendCalls, 0, 'all sends queued behind committed STOP must be rejected');
  } finally {
    redis.disconnect();
    await fixture.cleanup();
    await db.$disconnect();
  }
});


// A first accepted frame uses the exclusive billing transaction. Subsequent
// frames use a short Redis lease carrying the durable receipt generation. STOP
// must not wait for their delayed Redis operations: its tombstone is the
// linearization point that rejects those stale generations.
integration('activated native frames are generation-fenced without delaying STOP', async () => {
  const { acceptGatewayFrame, markNativeGatewayRevocationStarted } = await import('../src/workspace-gateway.js');
  const { seedReadySession } = await import('./fixtures/native-gateway-session.js');
  const db = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
  const fixture = await seedReadySession(db, crypto.randomBytes(8).toString('hex'), {
    bookingStatus: BookingStatus.STARTING, expectedSeconds: 900,
  });
  const channelId = crypto.randomUUID();
  const channelKey = 'workspace-gateway:ws-channel:' + channelId;
  const queueKey = 'workspace-gateway:ws-input:' + channelId;
  const bytesKey = 'workspace-gateway:ws-input-bytes:' + channelId;
  const cookieKey = 'gpubnb:test:shared-fence:' + channelId;
  const hintKey = 'workspace-gateway:ws-session-activated:' + fixture.session.id;
  const binding = JSON.stringify({
    sessionId: fixture.session.id, machineId: fixture.machine.id,
    browserSessionKey: cookieKey, runtimeBackend: 'WINDOWS_NATIVE',
  });
  const frame = { dataBase64: 'AA==', binary: true, close: false };
  const submit = () => acceptGatewayFrame({
    db, redis, sessionId: fixture.session.id, machineId: fixture.machine.id,
    channelId, bindingRaw: binding, frame,
  });
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    return { promise, open };
  };
  const bothEntered = gate(), releaseRedis = gate();
  const originalEval = redis.eval.bind(redis);
  let stop: Promise<boolean> | undefined;
  let pending: Promise<unknown>[] = [];
  try {
    await redis.set(channelKey, binding, 'EX', 120);
    await redis.set(cookieKey, JSON.stringify({sessionId: fixture.session.id, userId: fixture.renter.id}), 'EX', 120);
    assert.equal((await submit()).enqueued, 1, 'initial activation must commit a receipt first');
    assert.ok((await db.booking.findUniqueOrThrow({where:{id:fixture.booking.id}})).workspaceActivatedAt);
    const authority = await redis.get(hintKey);
    assert.ok(authority && !authority.startsWith('revoked:'), 'activation must publish its durable receipt generation');
    const beforePending = await redis.llen(queueKey);
    let entered = 0;
    redis.eval = (async (script: unknown, ...args: unknown[]) => {
      if (String(script).includes('The binding and enqueue are linearized by Redis')) {
        entered++;
        if (entered === 2) bothEntered.open();
        await releaseRedis.promise;
      }
      return (originalEval as (...args: unknown[]) => Promise<unknown>)(script, ...args);
    }) as typeof redis.eval;
    pending = [submit(), submit()];
    // If activated frames still take a PostgreSQL row lock, the second callback
    // cannot reach Redis concurrently.
    let timeout!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        bothEntered.promise,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('native_frames_still_serialized')), 3000); }),
      ]);
    } finally { clearTimeout(timeout); }
    stop = markNativeGatewayRevocationStarted(db, redis, fixture.session.id, fixture.machine.id);
    let stopTimeout!: ReturnType<typeof setTimeout>;
    try {
      assert.equal(await Promise.race([
        stop,
        new Promise<never>((_, reject) => { stopTimeout = setTimeout(() => reject(new Error('stop_waited_for_stale_frame_admissions')), 3000); }),
      ]), true, 'STOP must commit without waiting for lock-free frame snapshots');
    } finally { clearTimeout(stopTimeout); }
    assert.equal((await db.workspaceSession.findUniqueOrThrow({where:{id:fixture.session.id}})).status, WorkspaceSessionStatus.STOPPING);
    assert.match(await redis.get(hintKey) ?? '', /^revoked:/, 'STOP must replace the generation before it returns');
    releaseRedis.open();
    assert.deepEqual((await Promise.all(pending) as {enqueued:number}[]).map(x => x.enqueued), [-2, -2],
      'Redis must reject every database snapshot carrying the pre-STOP generation');
    assert.equal(await redis.llen(queueKey), beforePending, 'stale in-flight frames must not append queue bytes');
    assert.equal((await submit()).enqueued, -2, 'a fresh post-STOP attempt is denied by the database too');
    assert.equal(await redis.llen(queueKey), beforePending, 'a post-STOP frame must not enter the queue');
  } finally {
    releaseRedis.open();
    await Promise.allSettled(pending);
    if (stop) await stop.catch(() => undefined);
    redis.eval = originalEval as typeof redis.eval;
    await redis.del(channelKey, queueKey, bytesKey, cookieKey, hintKey).catch(() => undefined);
    redis.disconnect();
    await fixture.cleanup();
    await db.$disconnect();
  }
});
