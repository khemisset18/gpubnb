'use strict';
const miningCore = globalThis.GPUBNBProfitCore;
if (!miningCore) throw new Error('Moteur de calcul indisponible.');

/*
 * GPUbnb — comparateur autonome.
 * Catalogue de matériels et puissances approximatives, PAS des benchmarks.
 * Aucun revenu de minage fictif n'est embarqué.
 */
const DEVICES = [
  ['gpu','nvidia-rtx-5090','NVIDIA GeForce RTX 5090',400],
  ['gpu','nvidia-rtx-5080','NVIDIA GeForce RTX 5080',290],
  ['gpu','nvidia-rtx-5070-ti','NVIDIA GeForce RTX 5070 Ti',250],
  ['gpu','nvidia-rtx-5070','NVIDIA GeForce RTX 5070',200],
  ['gpu','nvidia-rtx-5060-ti','NVIDIA GeForce RTX 5060 Ti',150],
  ['gpu','nvidia-rtx-5060','NVIDIA GeForce RTX 5060',125],
  ['gpu','nvidia-rtx-4090','NVIDIA GeForce RTX 4090',340],
  ['gpu','nvidia-rtx-4080-super','NVIDIA GeForce RTX 4080 SUPER',265],
  ['gpu','nvidia-rtx-4080','NVIDIA GeForce RTX 4080',265],
  ['gpu','nvidia-rtx-4070-ti-super','NVIDIA GeForce RTX 4070 Ti SUPER',225],
  ['gpu','nvidia-rtx-4070-ti','NVIDIA GeForce RTX 4070 Ti',220],
  ['gpu','nvidia-rtx-4070-super','NVIDIA GeForce RTX 4070 SUPER',190],
  ['gpu','nvidia-rtx-4070','NVIDIA GeForce RTX 4070',165],
  ['gpu','nvidia-rtx-4060-ti','NVIDIA GeForce RTX 4060 Ti',135],
  ['gpu','nvidia-rtx-4060','NVIDIA GeForce RTX 4060',105],
  ['gpu','nvidia-rtx-3090','NVIDIA GeForce RTX 3090',285],
  ['gpu','nvidia-rtx-3080-ti','NVIDIA GeForce RTX 3080 Ti',300],
  ['gpu','nvidia-rtx-3080','NVIDIA GeForce RTX 3080',240],
  ['gpu','nvidia-rtx-3070-ti','NVIDIA GeForce RTX 3070 Ti',195],
  ['gpu','nvidia-rtx-3070','NVIDIA GeForce RTX 3070',155],
  ['gpu','nvidia-rtx-3060-ti','NVIDIA GeForce RTX 3060 Ti',140],
  ['gpu','nvidia-rtx-3060','NVIDIA GeForce RTX 3060',125],
  ['gpu','nvidia-rtx-3050','NVIDIA GeForce RTX 3050',95],
  ['gpu','amd-rx-9070-xt','AMD Radeon RX 9070 XT',245],
  ['gpu','amd-rx-9070','AMD Radeon RX 9070',210],
  ['gpu','amd-rx-9060-xt','AMD Radeon RX 9060 XT',150],
  ['gpu','amd-rx-7900-xtx','AMD Radeon RX 7900 XTX',275],
  ['gpu','amd-rx-7900-xt','AMD Radeon RX 7900 XT',245],
  ['gpu','amd-rx-7800-xt','AMD Radeon RX 7800 XT',210],
  ['gpu','amd-rx-7700-xt','AMD Radeon RX 7700 XT',195],
  ['gpu','amd-rx-7600-xt','AMD Radeon RX 7600 XT',145],
  ['gpu','amd-rx-7600','AMD Radeon RX 7600',125],
  ['gpu','amd-rx-6950-xt','AMD Radeon RX 6950 XT',255],
  ['gpu','amd-rx-6900-xt','AMD Radeon RX 6900 XT',220],
  ['gpu','amd-rx-6800-xt','AMD Radeon RX 6800 XT',200],
  ['gpu','amd-rx-6800','AMD Radeon RX 6800',175],
  ['gpu','amd-rx-6700-xt','AMD Radeon RX 6700 XT',150],
  ['gpu','amd-rx-6600-xt','AMD Radeon RX 6600 XT',105],
  ['gpu','amd-rx-6600','AMD Radeon RX 6600',85],
  ['gpu','intel-arc-b580','Intel Arc B580',165],
  ['gpu','intel-arc-a770','Intel Arc A770',180],
  ['gpu','intel-arc-a750','Intel Arc A750',165],
  ['cpu','amd-9950x','AMD Ryzen 9 9950X',170],
  ['cpu','amd-9900x','AMD Ryzen 9 9900X',120],
  ['cpu','amd-9800x3d','AMD Ryzen 7 9800X3D',100],
  ['cpu','amd-9700x','AMD Ryzen 7 9700X',85],
  ['cpu','amd-9600x','AMD Ryzen 5 9600X',75],
  ['cpu','amd-7950x','AMD Ryzen 9 7950X',170],
  ['cpu','amd-7900x','AMD Ryzen 9 7900X',125],
  ['cpu','amd-7800x3d','AMD Ryzen 7 7800X3D',95],
  ['cpu','amd-7700x','AMD Ryzen 7 7700X',100],
  ['cpu','amd-7600x','AMD Ryzen 5 7600X',85],
  ['cpu','amd-5950x','AMD Ryzen 9 5950X',135],
  ['cpu','amd-5900x','AMD Ryzen 9 5900X',115],
  ['cpu','amd-5800x3d','AMD Ryzen 7 5800X3D',90],
  ['cpu','amd-5800x','AMD Ryzen 7 5800X',90],
  ['cpu','amd-5700x','AMD Ryzen 7 5700X',75],
  ['cpu','amd-5600x','AMD Ryzen 5 5600X',65],
  ['cpu','intel-285k','Intel Core Ultra 9 285K',160],
  ['cpu','intel-265k','Intel Core Ultra 7 265K',125],
  ['cpu','intel-245k','Intel Core Ultra 5 245K',105],
  ['cpu','intel-14900k','Intel Core i9-14900K',215],
  ['cpu','intel-14700k','Intel Core i7-14700K',180],
  ['cpu','intel-14600k','Intel Core i5-14600K',140],
  ['cpu','intel-13900k','Intel Core i9-13900K',205],
  ['cpu','intel-13700k','Intel Core i7-13700K',165],
  ['cpu','intel-13600k','Intel Core i5-13600K',135]
].map(([kind,id,name,watts])=>({kind,id,name,watts}));

const byId = id => document.getElementById(id);
const eur = new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:2});
const eurFine = new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',minimumFractionDigits:2,maximumFractionDigits:4});
const num = new Intl.NumberFormat('fr-FR',{maximumFractionDigits:2});
const inputs = ['quantity','power','electricity','hours','poolFee','purchase'];
const state = {kind:'gpu',device:'nvidia-rtx-3060',manual:new Map(),live:new Map(),source:'',updatedAt:null,feedFetchFailed:false,hasHadFeed:false};

function numberField(id,min,max,optional=false){
  const value = byId(id).value.trim();
  if(optional && value==='')return null;
  if(value==='')return NaN;
  const n = Number(value.replace(',','.'));
  return Number.isFinite(n)&&n>=min&&n<=max?n:NaN;
}
function config(){
  return {
    quantity:numberField('quantity',1,100),
    watts:numberField('power',1,1500),
    electricity:numberField('electricity',0,5),
    hours:numberField('hours',0,24),
    poolFee:numberField('poolFee',0,100),
    purchase:numberField('purchase',0,1000000,true)
  };
}
function validConfig(s){return Object.values(s).every(v=>v===null||Number.isFinite(v))&&Number.isInteger(s.quantity);}
function liveFeedAvailable(){
  const age=Date.now()-state.updatedAt;
  return Number.isFinite(state.updatedAt)&&state.live.size>0 &&
    age>=-5*60000 && age<=miningCore.MAX_FEED_AGE_MS;
}
function savedFeed(){
  return liveFeedAvailable() && (state.feedFetchFailed ||
    Date.now()-state.updatedAt>miningCore.RECENT_FEED_MS);
}
function getRates(id){return liveFeedAvailable()?(state.live.get(id)||[]):[];}
function renderFeedStatus(){
  const el=byId('feedStatus'),active=liveFeedAvailable(),saved=savedFeed();
  el.classList.toggle('live',active&&!saved);
  el.replaceChildren();
  const dot=document.createElement('span');dot.className='tiny-dot';
  const text=active?
    (saved?'Dernier relevé sauvegardé · ':'Source : ')+state.source+
      ' · '+new Date(state.updatedAt).toLocaleString('fr-FR')+
      (saved?' · conservation maximum 24 h':''):
    state.hasHadFeed?'Service indisponible · aucun rendement automatique valide de moins de 24 h':
      'Mode manuel · Pas de flux temps réel connecté';
  el.append(dot,document.createTextNode(' '+text));
}
function rateFor(id){
  if(state.manual.has(id))return {gross:state.manual.get(id),mode:'manual'};
  const options=getRates(id);
  if(!options.length)return null;
  const chosen=id===state.device?options.find(x=>x.id===byId('coin').value):null;
  return chosen||options.reduce((a,b)=>a.gross>=b.gross?a:b);
}
function profit(rate,watts,s,quantity){
  if(!rate||!validConfig(s))return null;
  return miningCore.profit({
    grossEur24h:rate.gross,watts,quantity,hours:s.hours,
    electricityEurKwh:s.electricity,poolFeePercent:s.poolFee
  });
}
function put(id,value){byId(id).textContent=value;}
function updateCoins(){
  const options=getRates(state.device);
  const choose=byId('coin'), old=choose.value;
  choose.replaceChildren();
  const automatic=document.createElement('option');
  automatic.value='';automatic.textContent='Meilleure option disponible';
  choose.append(automatic);
  for(const opt of options){
    const node=document.createElement('option');
    node.value=opt.id;
    node.textContent=[opt.coin,opt.algorithm].filter(Boolean).join(' · ');
    choose.append(node);
  }
  if(options.some(x=>x.id===old))choose.value=old;
  byId('coinWrap').hidden=options.length<2||state.manual.has(state.device);
}
function syncRateInput(){
  updateCoins();
  const isManual=state.manual.has(state.device);
  const rate=rateFor(state.device);
  byId('gross').value=isManual?String(state.manual.get(state.device)):rate?String(rate.gross):'';
  put('grossHelp',isManual?'Valeur manuelle pour ce modèle. Modifiez-la pour recalculer.':rate?
    'Rendement fourni par '+state.source+'. Vous pouvez remplacer cette valeur manuellement.':
    'Aucun rendement automatique disponible. Saisissez le revenu brut sur 24 h fourni par votre pool.');
}
function renderResults(){
  const s=config(), ok=validConfig(s);
  const data=ok?profit(rateFor(state.device),s.watts,s,s.quantity):null;
  put('day',data?eur.format(data.net):'—');
  put('month',data?eur.format(data.net*30):'—');
  put('year',data?eur.format(data.net*365):'—');
  put('grossOut',data?eurFine.format(data.gross):'—');
  put('electricOut',ok?'− '+eurFine.format(s.watts/1000*s.hours*s.electricity*s.quantity):'—');
  put('poolOut',data?'− '+eurFine.format(data.fees):'—');
  put('netOut',data?eurFine.format(data.net):'—');
  put('kwhOut',ok?num.format(s.watts/1000*s.hours*s.quantity)+' kWh':'—');
  put('roiOut',data&&s.purchase!=null&&s.purchase>0?
    data.net>0?num.format(Math.ceil(s.purchase*s.quantity/data.net))+' j':'Non rentable':'—');
  const rate=rateFor(state.device),mode=byId('resultBadge');
  mode.textContent=!rate?'À renseigner':rate.mode==='live'?(savedFeed()?'Relevé sauvegardé':'Source connectée'):'Calcul manuel';
  mode.classList.toggle('live',Boolean(rate&&rate.mode==='live'&&!savedFeed()));
  renderFeedStatus();
  for(const id of ['day','month','year','netOut']){
    byId(id).classList.toggle('negative',Boolean(data&&data.net<0));
    byId(id).classList.toggle('positive',Boolean(data&&data.net>0));
  }
  byId('resultNotice').classList.toggle('loss',Boolean(data&&data.net<0));
  put('resultNotice',!ok?'Corrigez les paramètres du calcul.':!rate?
    'Saisissez votre revenu brut quotidien afin d’obtenir le rendement net.':
    data.net<0?'Cette configuration présente une perte estimée avec vos coûts actuels.':
    data.net===0?'Le résultat estimé est à l’équilibre.':
    'Estimation pour '+s.quantity+' appareil'+(s.quantity>1?'s':'')+', '+num.format(s.hours)+' h/jour.');
  renderTable();
}
function renderSelect(){
  const term=byId('deviceSearch').value.trim().toLowerCase();
  const options=DEVICES.filter(x=>x.kind===state.kind&&x.name.toLowerCase().includes(term));
  const el=byId('deviceSelect');el.replaceChildren();el.disabled=!options.length;
  if(!options.length){const opt=document.createElement('option');opt.textContent='Aucun modèle trouvé';el.append(opt);return;}
  for(const d of options){const opt=document.createElement('option');opt.value=d.id;opt.textContent=d.name;el.append(opt);}
  el.value=options.some(x=>x.id===state.device)?state.device:options[0].id;
}
function chooseDevice(id,scroll=false){
  const device=DEVICES.find(x=>x.id===id);
  if(!device)return;
  state.kind=device.kind;state.device=device.id;
  for(const k of ['gpu','cpu']){
    byId(k==='gpu'?'tabGpu':'tabCpu').classList.toggle('on',k===state.kind);
    byId(k==='gpu'?'tabGpu':'tabCpu').setAttribute('aria-pressed',String(k===state.kind));
  }
  byId('deviceSearch').value='';
  renderSelect();
  byId('deviceSelect').value=device.id;
  byId('power').value=device.watts;
  syncRateInput();renderResults();
  if(scroll)byId('calculateur').scrollIntoView({behavior:'smooth',block:'start'});
}
function renderTable(){
  const query=byId('tableSearch').value.toLowerCase().trim();
  const options=DEVICES.filter(d=>d.kind===state.kind&&d.name.toLowerCase().includes(query));
  const table=byId('tableBody');table.replaceChildren();
  const s=config();
  for(const device of options){
    const watts=device.id===state.device?s.watts:device.watts;
    const cost=validConfig(s)?watts/1000*s.hours*s.electricity:null;
    // Le tableau compare toujours un seul appareil par ligne.
    const result=validConfig(s)?profit(rateFor(device.id),watts,s,1):null;
    const tr=document.createElement('tr');
    for(const value of [device.name,watts+' W',cost===null?'—':eur.format(cost),result?eur.format(result.net):'—']){
      const td=document.createElement('td');td.textContent=value;tr.append(td);
    }
    if(result)tr.children[3].classList.add(result.net<0?'negative':'positive');
    const td=document.createElement('td'),button=document.createElement('button');
    button.type='button';button.className='choose-button';
    button.textContent=device.id===state.device?'Sélectionné':'Choisir';
    button.addEventListener('click',()=>chooseDevice(device.id,true));
    td.append(button);tr.append(td);table.append(tr);
  }
  byId('tableEmpty').hidden=options.length>0;
}
function validateFeed(doc){
  return miningCore.validateFeed(doc,new Set(DEVICES.map(d=>d.id)));
}
async function refreshFeed(){
  try{
    const response=await fetch('data/rendements.json?t='+Date.now(),{cache:'no-store'});
    if(!response.ok)throw Error('Flux indisponible');
    const parsed=validateFeed(await response.json());
    if(!parsed)throw Error('Aucune donnée fraîche');
    if(Number.isFinite(state.updatedAt)&&parsed.ts<state.updatedAt)
      throw Error('Réponse arrivée en retard : ne pas remplacer un relevé plus récent');
    state.live=parsed.map;state.source=parsed.source;state.updatedAt=parsed.ts;
    state.feedFetchFailed=false;state.hasHadFeed=true;
  }catch{
    // Keep the last successful earnings snapshot in memory, without extending its timestamp.
    // getRates() hides it automatically once it is older than 24 hours.
    state.feedFetchFailed=true;
  }
  syncRateInput();renderResults();renderTable();
}
byId('tabGpu').addEventListener('click',()=>chooseDevice('nvidia-rtx-3060'));
byId('tabCpu').addEventListener('click',()=>chooseDevice('amd-9950x'));
byId('deviceSearch').addEventListener('input',()=>{
  renderSelect();const id=byId('deviceSelect').value;
  if(id&&id!==state.device){
    const d=DEVICES.find(x=>x.id===id);
    if(d){state.device=id;byId('power').value=d.watts;syncRateInput();renderResults();}
  }
});
byId('deviceSelect').addEventListener('change',()=>chooseDevice(byId('deviceSelect').value));
byId('gross').addEventListener('input',()=>{
  const raw=byId('gross').value.trim();
  if(!raw)state.manual.delete(state.device);
  else{
    const n=numberField('gross',0,100000);
    if(Number.isFinite(n))state.manual.set(state.device,n);
    else state.manual.delete(state.device);
  }
  updateCoins();renderResults();
});
byId('coin').addEventListener('change',()=>{
  if(!state.manual.has(state.device)){
    const rate=rateFor(state.device);
    byId('gross').value=rate?String(rate.gross):'';
    renderResults();
  }
});
for(const id of inputs)byId(id).addEventListener('input',renderResults);
byId('tableSearch').addEventListener('input',renderTable);
byId('refresh').addEventListener('click',refreshFeed);
chooseDevice(state.device);
refreshFeed();
// Hourly source: limit redundant requests and use local time checks for hard expiry.
setInterval(refreshFeed,15*60*1000);
let hadLiveFeed=liveFeedAvailable();
setInterval(()=>{
  const validNow=liveFeedAvailable();
  if(validNow!==hadLiveFeed){
    hadLiveFeed=validNow;
    syncRateInput();
    renderTable();
  }
  renderResults();
},60*1000);
