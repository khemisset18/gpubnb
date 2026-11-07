import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'isolated-test-session-secret-0123456789';
process.env.INTERNAL_SERVICE_TOKEN ??= 'isolated-test-internal-token-0123456789';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';
const { authorizeQueuedGatewayRelay, authorizeQueuedGatewayBatch } = await import('../src/workspace-gateway.js');

function fixture(kind: 'ws_send' | 'ws_open') {
  const binding = JSON.stringify({sessionId:'s',machineId:'m',browserSessionKey:'browser',runtimeBackend:'WINDOWS_NATIVE'});
  type SessionRow = {id:string;renterId:string;machineId:string;runtimeBackend:string;status:string;expiresAt:Date};
  type State = {row:SessionRow|null;readFence:()=>Promise<SessionRow|null>;binding:string|null;browser:string|null};
  const state:State = {
    row: {id:'s',renterId:'u',machineId:'m',runtimeBackend:'WINDOWS_NATIVE',status:'READY',expiresAt:new Date(Date.now()+60000)} as SessionRow|null,
    readFence: async ():Promise<SessionRow|null> => state.row,
    binding: binding as string|null,
    browser: JSON.stringify({sessionId:'s',userId:'u'}) as string|null,
  };
  const queued = {id:'r',sessionId:'s',kind,channelId:'c',nativeChannelBinding:binding,dataBase64:'AA==',binary:true};
  const db = {
    workspaceSession:{findFirst:async()=>state.row},
    $transaction:async (operation:(tx:{$queryRaw:(...args:unknown[])=>Promise<unknown[]>})=>Promise<unknown>)=>operation({
      $queryRaw:async (..._query:unknown[])=>{
        const row=await state.readFence();
        if(!row||!['READY','RUNNING'].includes(row.status)||row.expiresAt.getTime()<=Date.now())return [];
        return [{id:row.id,machineId:row.machineId,renterId:row.renterId,runtimeBackend:row.runtimeBackend,remainingMs:BigInt(row.expiresAt.getTime()-Date.now())}];
      },
    }),
  };
  const redis = {
    get:async()=>state.browser,
    eval:async(_script:string,_count:number,_channel:string,_browser:string,expectedBinding:string,expectedBrowser:string)=>
      state.binding===expectedBinding&&state.browser===expectedBrowser?1:0,
  };
  const authorize = () => authorizeQueuedGatewayRelay(db as never,redis as never,'m',queued);
  return {state,queued,db,redis,authorize};
}
for (const kind of ['ws_send','ws_open'] as const) {
  test(`queued native ${kind} requires fresh DB authority and exact Redis binding`, async () => {
    const f = fixture(kind);
    const allowed = await f.authorize();
    assert.ok(allowed);
    assert.equal('nativeChannelBinding' in allowed, false, 'internal fence must never change the Agent wire protocol');
    f.state.row = null;
    assert.equal(await f.authorize(),null,'STOP committed in PostgreSQL');
  });
  for (const revoke of ['cookie','channel','replace-channel','renter','machine','backend','expired','unfenced'] as const) {
    test(`queued ${kind} is discarded on ${revoke}`,async()=>{
      const f=fixture(kind);
      if(revoke==='cookie')f.state.browser=null;
      if(revoke==='channel')f.state.binding=null;
      if(revoke==='replace-channel')f.state.binding+=' ';
      if(revoke==='renter')f.state.row!.renterId='other';
      if(revoke==='machine')f.state.row!.machineId='other';
      if(revoke==='backend')f.state.row!.runtimeBackend='CONTAINER';
      if(revoke==='expired')f.state.row!.expiresAt=new Date(0);
      if(revoke==='unfenced')delete (f.queued as {nativeChannelBinding?:string}).nativeChannelBinding;
      assert.equal(await f.authorize(),null);
    });
  }
  test(`cookie revocation during queued ${kind} DB read fences the stale positive`,async()=>{
    const f=fixture(kind);
    let release!:()=>void, entered!:()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;});
    f.state.readFence=async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});return f.state.row;};
    const pending=f.authorize();
    await reading;
    f.state.browser=null;
    release();
    assert.equal(await pending,null);
  });
  test(`channel revocation during queued ${kind} browser read fences the stale cookie`,async()=>{
    const f=fixture(kind);
    let release!:()=>void, entered!:()=>void;
    const barrier=new Promise<void>(resolve=>{entered=resolve;});
    f.redis.get=async()=>{
      const old=f.state.browser;
      entered();
      await new Promise<void>(resolve=>{release=resolve;});
      return old;
    };
    const pending=f.authorize();
    await barrier;
    f.state.binding=null;
    release();
    assert.equal(await pending,null);
  });
  test(`DB and Redis failures deny queued ${kind}`,async()=>{
    const f=fixture(kind);
    f.state.readFence=async()=>{throw new Error('database unavailable');};
    assert.equal(await f.authorize(),null);
    const g=fixture(kind);
    g.redis.get=async()=>{throw new Error('redis unavailable');};
    assert.equal(await g.authorize(),null);
  });
}
test('STOP committed while several native relays await the session-row lock denies every stale operation',async()=>{
  const f=fixture('ws_send');
  let entered=0,release!:()=>void,allEntered!:()=>void;
  const waiting=new Promise<void>(resolve=>{allEntered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.state.readFence=async()=>{
    entered++;
    if(entered===3)allEntered();
    await gate;
    return f.state.row;
  };
  const pending=[0,1,2].map(index=>authorizeQueuedGatewayRelay(
    f.db as never,f.redis as never,'m',{...f.queued,id:`r${index}`,channelId:`c${index}`},
  ));
  await waiting;
  f.state.row!.status='STOPPING';
  release();
  assert.deepEqual(await Promise.all(pending),[null,null,null]);
});
test('cleanup close commands remain deliverable after native authority disappears',async()=>{
  const f=fixture('ws_send');f.state.row=null;
  const close={...f.queued,kind:'ws_close' as const};
  assert.deepEqual(await authorizeQueuedGatewayRelay(f.db as never,f.redis as never,'m',close),
    {id:'r',sessionId:'s',kind:'ws_close',channelId:'c',dataBase64:'AA==',binary:true});
});

test('unresponsive queued authority times out without later returning a grant',async()=>{
  const f=fixture('ws_send');
  let release!:()=>void, entered!:()=>void;
  const reading=new Promise<void>(resolve=>{entered=resolve;});
  f.state.readFence=async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});return f.state.row;};
  const pending=authorizeQueuedGatewayRelay(f.db as never,f.redis as never,'m',f.queued,10);
  await reading;
  assert.equal(await pending,null);
  release();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(await pending,null,'late query completion cannot change the delivered result');
});
test('current container relays remain wire compatible and stripped of native metadata',async()=>{
  const f=fixture('ws_send');
  f.state.row!.runtimeBackend='CONTAINER';
  delete (f.queued as {nativeChannelBinding?:string}).nativeChannelBinding;
  assert.deepEqual(await f.authorize(),f.queued);
});

test('a revoked old channel does not drop a fresh reconnect OPEN for the same session',async()=>{
  const f=fixture('ws_send');
  const fresh={...f.queued,id:'new',kind:'ws_open' as const,channelId:'new-channel'};
  f.redis.eval=async(_script,_count,channel)=>channel.endsWith(':new-channel')?1:0;
  const result=await authorizeQueuedGatewayBatch(f.db as never,f.redis as never,'m',[fresh,f.queued]);
  assert.equal(result.length,1);
  assert.equal(result[0]!.id,'new');
  assert.equal('nativeChannelBinding' in result[0]!,false);
});
test('a later channel denial also removes an earlier positive for that same channel',async()=>{
  const f=fixture('ws_send');let reads=0;
  f.redis.eval=async()=>++reads===1?1:0;
  const result=await authorizeQueuedGatewayBatch(f.db as never,f.redis as never,'m',[f.queued,{...f.queued,id:'later'}]);
  assert.deepEqual(result,[]);
});
test('a later database STOP removes earlier positives across the whole session',async()=>{
  const f=fixture('ws_send');let reads=0;
  f.state.readFence=async()=>++reads===1?f.state.row:null;
  const close={...f.queued,id:'cleanup',kind:'ws_close' as const};
  const result=await authorizeQueuedGatewayBatch(f.db as never,f.redis as never,'m',[f.queued,{...f.queued,id:'other',channelId:'other-channel'},close]);
  assert.deepEqual(result.map(item=>item.id),['cleanup']);
});
