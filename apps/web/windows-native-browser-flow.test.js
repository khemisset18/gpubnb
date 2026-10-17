// Browser orchestration only: real client scripts, simulated DOM/HTTP/auth SDK.
// No account, booking, signing key, GPU or remote desktop is used by these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const response=(status,data)=>({ok:status>=200&&status<300,status,json:async()=>data});
const intent='choose-workspace.html?listing=gpu-1&workspace=cloud-desktop';
const workspace={slug:'cloud-desktop',name:'Cloud Desktop',compatible:true,bookable:true,
  compatibility:{score:100,state:'READY',missing:[]},technologies:[],summary:'Bureau',icon:'',release:'Bêta'};
const listing={id:'gpu-1',title:'GPU privé',gpu:{model:'NVIDIA',vramMiB:4096},workspaces:[workspace]};

function node(){
  return {style:{},dataset:{},hidden:false,disabled:false,textContent:'',value:'',children:[],events:new Map(),attributes:{},
    classList:{toggle(){}},setAttribute(name,value){this.attributes[name]=value},
    getAttribute(name){return this.attributes[name]},querySelector(){return null},
    replaceChildren(...children){this.children=children},append(...children){this.children.push(...children)},
    addEventListener(event,handler){this.events.set(event,handler)},remove(){}};
}
function storage(){const values=new Map();return {getItem:key=>values.get(key)??null,
  setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}}
function browser({route='/choose-workspace.html',search='',fetcher,sessionStorage=storage(),groups={}}={}){
  const nodes=new Map();const calls=[];const timers=[];const domEvents=new Map();
  const location={origin:'https://gpubnb.invalid',pathname:route,search,href:route+search,
    assign(value){this.href=value},replace(value){this.href=value}};
  const document={
    querySelector(selector){
      if(['#profileForm','#dashboardRoot','.toast'].includes(selector)&&!nodes.has(selector))return null;
      if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);
    },
    querySelectorAll:selector=>groups[selector]||[],createElement:()=>node(),
    addEventListener:(name,handler)=>domEvents.set(name,handler),body:{append(){},insertAdjacentHTML(){}},
  };
  const window={location,addEventListener(){}};
  const context=vm.createContext({document,window,location,URL,URLSearchParams,TextEncoder,console,
    sessionStorage,prompt:()=> '5',crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000000'},
    setTimeout(handler){timers.push(handler);return timers.length},clearTimeout(){},clearInterval(){},
    fetch:async(url,options={})=>{
      const parsed=new URL(url,location.origin);const path=parsed.pathname+parsed.search;
      calls.push({path,options});assert.equal(options.credentials,'include');
      if(fetcher)return fetcher(path,options);
      throw new Error(`Unexpected mock request: ${path}`);
    },
  });
  const box={context,window,location,document,nodes,calls,timers,sessionStorage,
    load(name){vm.runInContext(source(name),context,{filename:name})},
    run(code){return vm.runInContext(code,context)},
  };
  box.load('browser-login-return.js');return box;
}
async function settle(){for(let i=0;i<100;i++)await Promise.resolve()}
function prepare(box,choice=workspace){
  box.context.testListing=listing;box.context.testWorkspace=choice;box.context.testButton=node();
  return box.run('prepareSelected(testListing,testWorkspace,testButton)');
}
function chosen(box){return box.document.querySelector('#workspaceChoices').children}
function success(path){
  if(path.includes('/workspace-catalogue'))return response(200,listing);
  if(path==='/auth/me')return response(200,{user:{id:'renter-1'}});
  if(path==='/bookings')return response(200,{id:'booking-1'});
  if(path==='/bookings/booking-1/workspace/cloud-desktop')return response(200,{});
  throw new Error(`Unexpected mock request: ${path}`);
}

test('expired Web session returns to Google/email login with GPU and workspace; no wallet or mutation',async()=>{
  const box=browser({fetcher:()=>response(401,{error:'unauthorized'})});box.load('choose-workspace.js');
  await prepare(box);
  assert.equal(box.location.href,'auth.html?next='+encodeURIComponent(intent));
  assert.match(box.document.querySelector('#workspaceStatus').textContent,/Google ou par e-mail/);
  assert.deepEqual(box.calls.map(call=>call.path),['/auth/me']);
  assert.equal(box.window.solana,undefined);
});

for(const status of [403,409,429,500])test(`auth refusal ${status} is displayed without wallet fallback or login redirect`,async()=>{
  const box=browser({fetcher:()=>response(status,{error:'server_refusal'})});box.load('choose-workspace.js');
  await prepare(box);
  assert.equal(box.location.href,'/choose-workspace.html');
  assert.match(box.document.querySelector('#workspaceStatus').textContent,/server_refusal/);
  assert.equal(box.calls.length,1);
});
test('network failure remains a service error, without a different authentication identity',async()=>{
  const box=browser({fetcher:()=>{throw new Error('network_unavailable')}});box.load('choose-workspace.js');
  await prepare(box);assert.equal(box.calls.length,1);
  assert.match(box.document.querySelector('#workspaceStatus').textContent,/network_unavailable/);
  assert.equal(box.location.href,'/choose-workspace.html');
});

test('existing Web session creates and prepares a booking without an installed wallet',async()=>{
  const box=browser({fetcher:success});box.load('choose-workspace.js');await prepare(box);
  assert.equal(box.location.href,'bookings.html');
  assert.deepEqual(box.calls.map(call=>call.path),['/auth/me','/bookings','/bookings/booking-1/workspace/cloud-desktop']);
  const body=JSON.parse(box.calls[1].options.body);
  assert.equal(body.listingId,'gpu-1');assert.ok(body.idempotencyKey);
  assert.equal(box.sessionStorage.getItem('gpubnb.workspace.pending-booking'),null);
});

test('reconnection restores the chosen workspace from a fresh server catalogue without automatic booking',async()=>{
  const box=browser({search:'?listing=gpu-1&workspace=cloud-desktop',fetcher:success});box.load('choose-workspace.js');await settle();
  assert.equal(chosen(box).length,1);
  assert.match(chosen(box)[0].children[0].textContent,/sélectionné/);
  assert.equal(box.calls.length,2);assert.ok(box.calls.every(call=>!call.options.method));
});
for(const unavailable of [{compatible:false},{bookable:false}])test(`retained choice cannot override server catalogue ${JSON.stringify(unavailable)}`,async()=>{
  const denied={...workspace,...unavailable};
  const box=browser({search:'?listing=gpu-1&workspace=cloud-desktop',fetcher:()=>response(200,{...listing,workspaces:[denied]})});
  box.load('choose-workspace.js');await settle();assert.equal(chosen(box).length,0);
  const count=box.calls.length;await prepare(box,denied);assert.equal(box.calls.length,count);
});
for(const status of [403,409])test(`booking refusal ${status} never starts a workspace`,async()=>{
  const box=browser({fetcher:path=>path==='/bookings'?response(status,{error:'booking_not_allowed'}):success(path)});
  box.load('choose-workspace.js');await prepare(box);
  assert.equal(box.location.href,'/choose-workspace.html');
  assert.deepEqual(box.calls.map(call=>call.path),['/auth/me','/bookings']);
});
for(const status of [403,409])test(`workspace refusal ${status} is not masked by reconnection`,async()=>{
  const box=browser({fetcher:path=>path.endsWith('/workspace/cloud-desktop')?response(status,{error:'workspace_not_allowed'}):success(path)});
  box.load('choose-workspace.js');await prepare(box);
  assert.equal(box.location.href,'/choose-workspace.html');assert.equal(box.calls.length,3);
  assert.match(box.document.querySelector('#workspaceStatus').textContent,/workspace_not_allowed/);
});

async function interruptedBooking(sessionStorage){
  const box=browser({sessionStorage,fetcher:path=>path.endsWith('/workspace/cloud-desktop')?response(401,{error:'unauthorized'}):success(path)});
  box.load('choose-workspace.js');await prepare(box);return box;
}
test('expiry after booking creation resumes the same booking only after an explicit click and matching account',async()=>{
  const state=storage();const first=await interruptedBooking(state);
  assert.equal(first.location.href,'auth.html?next='+encodeURIComponent(intent));
  const returned=browser({sessionStorage:state,search:'?listing=gpu-1&workspace=cloud-desktop',fetcher:success});
  returned.load('choose-workspace.js');await settle();assert.equal(returned.calls.filter(c=>c.options.method==='POST').length,0);
  await prepare(returned);assert.equal(returned.location.href,'bookings.html');
  assert.equal(returned.calls.filter(c=>c.path==='/bookings').length,0);
  assert.equal(returned.calls.filter(c=>c.path==='/bookings/booking-1/workspace/cloud-desktop').length,1);
});
test('a different reconnected account cannot resume another account’s saved booking',async()=>{
  const state=storage();await interruptedBooking(state);
  const box=browser({sessionStorage:state,fetcher:path=>path==='/auth/me'?response(200,{user:{id:'different-renter'}}):success(path)});
  box.load('choose-workspace.js');await prepare(box);
  assert.equal(box.calls.filter(c=>c.path==='/bookings').length,1);
});
test('unavailable browser storage sends an interrupted existing booking to the booking list',async()=>{
  const state={getItem(){throw new Error('storage_blocked')},setItem(){throw new Error('storage_blocked')},removeItem(){}};
  const box=await interruptedBooking(state);
  assert.equal(box.location.href,'auth.html?next=bookings.html');
});

test('login return allowlist preserves public choice identifiers and existing internal destinations',()=>{
  const box=browser();const nav=box.window.GPUBNB_BROWSER_NAVIGATION;
  for(const path of [intent,'choose-workspace.html?listing=gpu-1','stage3-windows-native.html','bookings.html','dashboard.html'])assert.equal(nav.safeReturnPath(path),path);
  assert.equal(nav.safeReturnPath('dashboard'),'dashboard.html');assert.equal(Object.isFrozen(nav),true);
});
test('login return rejects external destinations, path tricks, grants, duplicate and unknown parameters',()=>{
  const nav=browser().window.GPUBNB_BROWSER_NAVIGATION;
  for(const path of [null,'https://evil.invalid/','//evil.invalid','javascript:alert(1)','\\evil.invalid','../bookings.html',
    '%2e%2e/bookings.html','/bookings.html','bookings.html#token','bookings.html?grant=secret','dashboard.html\n',
    'choose-workspace.html?listing=a&listing=b','choose-workspace.html?listing=a&workspace=x&workspace=y',
    'choose-workspace.html?listing=a&grant=secret','choose-workspace.html?listing=a&workspace=../evil',
    'choose-workspace.html?listing=a%26grant%3Dsecret','choose-workspace.html?listing=a?workspace=compute',
    'windows-native-desktop.html?session=x','stage3-windows-native.html?grant=secret']){
    assert.equal(nav.safeReturnPath(path),'dashboard.html',String(path));
  }
});

function authBrowser({onboarding=false,exchangeStatus=200}={}){
  const box=browser({route:'/auth.html',search:'?next='+encodeURIComponent(intent),fetcher:path=>{
    assert.equal(path,'/auth/supabase');return response(exchangeStatus,exchangeStatus===200?{user:{needsOnboarding:onboarding}}:{error:'invalid_supabase_session'});
  }});
  const captured={};let connected=false;
  const auth={
    getSession:async()=>({data:{session:connected?{access_token:'simulated-token'}:null}}),
    signInWithOAuth:async options=>{captured.oauth=options;return {}},
    signInWithPassword:async()=>{connected=true;return {data:{session:{}},error:null}},
    signOut:async options=>{captured.signOut=options},
  };
  box.window.GPUBNB_AUTH_CONFIG={supabaseUrl:'https://auth.invalid',supabaseAnonKey:'public-test-placeholder'};
  box.window.supabase={createClient:()=>({auth})};
  box.load('auth.js');return {...box,captured};
}
test('Google redirect and callback preserve the safe GPU/workspace destination',async()=>{
  const box=authBrowser();await settle();await box.nodes.get('#google').events.get('click')();
  const redirect=new URL(box.captured.oauth.options.redirectTo);
  assert.equal(redirect.origin,box.location.origin);assert.equal(redirect.pathname,'/auth.html');
  assert.equal(redirect.searchParams.get('next'),intent);
  assert.equal(box.run('destination(false)'),intent);
});
test('email reconnection returns to the selected workspace after the existing server session exchange',async()=>{
  const box=authBrowser();await settle();box.document.querySelector('#email').value='renter@example.invalid';
  await box.nodes.get('#email-form').events.get('submit')({preventDefault(){}});
  assert.equal(box.location.href,intent);assert.equal(box.calls.length,1);
});
test('onboarding remains mandatory when the server requests it, with safe return preserved',async()=>{
  const box=authBrowser({onboarding:true});await settle();
  await box.nodes.get('#email-form').events.get('submit')({preventDefault(){}});
  assert.equal(box.location.href,'onboarding.html?next='+encodeURIComponent(intent));
});
test('rejected auth exchange does not navigate or override the existing local sign-out control',async()=>{
  const box=authBrowser({exchangeStatus:401});await settle();
  await box.nodes.get('#email-form').events.get('submit')({preventDefault(){}});
  assert.equal(box.location.href,'/auth.html?next='+encodeURIComponent(intent));
  assert.equal(box.captured.signOut.scope,'local');assert.match(box.nodes.get('#status').textContent,/expirée/);
});

function onboardingBrowser(status=200,saveStatus=200){
  const box=browser({route:'/onboarding.html',search:'?next='+encodeURIComponent(intent),fetcher:(path,options)=>{
    assert.equal(path,'/profile');
    return options.method==='PUT'?response(saveStatus,{error:'profile_save_denied'}):response(status,{user:{canRent:true,canHost:false}});
  }});
  const form=node();form.elements=Object.fromEntries(['pseudonym','firstName','lastName','phone','countryCode','language','bio',
    'companyName','websiteUrl','avatarUrl','canRent','canHost'].map(key=>[key,{value:'',checked:false}]));
  box.nodes.set('#profileForm',form);box.load('account.js');return box;
}
test('completed onboarding restores the selected GPU/workspace without activating the host role',async()=>{
  const box=onboardingBrowser();await settle();await box.nodes.get('#profileForm').events.get('submit')({preventDefault(){}});
  assert.equal(box.location.href,intent);
  const body=JSON.parse(box.calls[1].options.body);assert.equal(body.canRent,true);assert.equal(body.canHost,false);
});
for(const phase of ['load','save'])test(`onboarding session expiry during ${phase} keeps the validated choice`,async()=>{
  const box=onboardingBrowser(phase==='load'?401:200,phase==='save'?401:200);await settle();
  if(phase==='save')await box.nodes.get('#profileForm').events.get('submit')({preventDefault(){}});
  assert.equal(box.location.href,'auth.html?next='+encodeURIComponent(intent));
});

for(const bookings of [[],[{id:'booking-1'}]])test(`renter dashboard guides ${bookings.length?'existing bookings':'GPU selection'} without host installation`,async()=>{
  const hostOnly=[node(),node()];const data={user:{canRent:true,canHost:false,needsOnboarding:false,pseudonym:'Renter'},host:{machines:[],listings:[]},tenant:{bookings}};
  const box=browser({route:'/dashboard.html',groups:{'[data-host-only]':hostOnly},fetcher:()=>response(200,data)});
  box.load('portal.js');await box.run('dashboard()');
  assert.equal(box.nodes.get('[data-next-link]').href,bookings.length?'bookings.html':'index.html#market');
  assert.ok(hostOnly.every(element=>element.hidden));
});
test('host guidance and mandatory profile completion retain their previous purpose',()=>{
  const box=browser();box.load('portal.js');
  box.context.data={user:{canRent:false,canHost:true,needsOnboarding:false},host:{machines:[],listings:[]},tenant:{bookings:[]}};
  assert.equal(box.run('nextStep(data)[2]'),'host-install.html');
  box.context.data.user.needsOnboarding=true;assert.equal(box.run('nextStep(data)[2]'),'onboarding.html');
});

const privateReplies={
  '/auth/me':{user:{id:'renter-1'}},
  '/qualification/windows-native/preflight':{privateNoPaymentMode:true,allowed:true,code:'PRIVATE_WINDOWS_TEST_ATTEMPT_ALLOWED'},
  '/qualification/windows-native/booking':{bookingId:'booking-1'},
  '/dashboard':{tenant:{bookings:[{id:'booking-1',status:'FUNDED'}]}},
  '/bookings/booking-1/workspace/cloud-desktop?qualification=windows-native':{},
  '/bookings/booking-1/workspace/cloud-desktop/status':{status:'READY',canOpen:true},
  '/bookings/booking-1/workspace/cloud-desktop/access':{openPath:'/workspace-gateway/session-1?grant=simulated-one-use-grant'},
};
async function privateRun(override=()=>null){
  const box=browser({route:'/stage3-windows-native.html',fetcher:path=>{
    const result=override(path);if(result)return result;
    assert.ok(Object.hasOwn(privateReplies,path),path);return response(200,privateReplies[path]);
  }});
  box.load('stage3-windows-native.js');assert.equal(box.calls.length,0);
  box.nodes.get('#stage3-start').events.get('click')();await settle();return box;
}
test('private desktop opens only after server authentication, booking, funding, readiness and access grant',async()=>{
  const box=await privateRun();assert.deepEqual(box.calls.map(c=>c.path),Object.keys(privateReplies));
  assert.equal(box.location.href,privateReplies['/bookings/booking-1/workspace/cloud-desktop/access'].openPath);
  assert.equal(box.window.solana,undefined);
});
for(const phase of Object.keys(privateReplies))test(`private flow expiry at ${phase} returns to Web login`,async()=>{
  const box=await privateRun(path=>path===phase?response(401,{error:'unauthorized'}):null);
  assert.equal(box.location.href,'auth.html?next=stage3-windows-native.html');
  assert.equal(box.calls.at(-1).path,phase);
});
for(const phase of Object.keys(privateReplies).slice(1))for(const status of [403,409])test(`private server refusal ${status} at ${phase} stops without opening`,async()=>{
  const box=await privateRun(path=>path===phase?response(status,{error:'private_access_denied'}):null);
  assert.equal(box.location.href,'/stage3-windows-native.html');assert.equal(box.calls.at(-1).path,phase);
  assert.match(box.nodes.get('#stage3-status').textContent,/private_access_denied/);
});
test('private flow cannot open a desktop before funding or when readiness denies access',async()=>{
  for(const [phase,value] of [['/dashboard',{tenant:{bookings:[{id:'booking-1',status:'AWAITING_DEPOSIT'}]}}],
    ['/bookings/booking-1/workspace/cloud-desktop/status',{status:'PREPARING',canOpen:false}]]){
    const box=await privateRun(path=>path===phase?response(200,value):null);
    assert.equal(box.location.href,'/stage3-windows-native.html');assert.equal(box.timers.length,1);
    assert.ok(!box.calls.some(call=>call.path.endsWith('/access')));
  }
});
test('terminal private session refusal never requests an access grant',async()=>{
  const box=await privateRun(path=>path.endsWith('/status')?response(200,{status:'QUARANTINED',canOpen:false}):null);
  assert.equal(box.location.href,'/stage3-windows-native.html');assert.ok(!box.calls.some(call=>call.path.endsWith('/access')));
  assert.match(box.nodes.get('#stage3-status').textContent,/QUARANTINED/);
});

test('browser pages load the validated return helper before consumers and hide owner-only dashboard blocks initially',()=>{
  for(const [page,consumer] of [['auth.html','auth.js'],['onboarding.html','account.js'],
    ['choose-workspace.html','choose-workspace.js'],['stage3-windows-native.html','stage3-windows-native.js']]){
    const html=source(page);assert.ok(html.indexOf('src="browser-login-return.js"')<html.indexOf(`src="${consumer}"`));
  }
  const html=source('dashboard.html');assert.equal((html.match(/data-host-only hidden/g)||[]).length,11);
  assert.match(source('portal.css'),/\[data-host-only\]\[hidden\]\{display:none!important\}/);
});
