/* Independent GPUbnb GPU PoW estimator. No commercial sources, no fabricated benchmarks. */
import { COINS, estimatePoW, estimateMeasuredPayout, validateOwnPoWSnapshot } from './lib/pow-yield.mjs';

const byId = id => document.getElementById(id);
const euro = new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:4});
const crypto = new Intl.NumberFormat('fr-FR',{maximumFractionDigits:10});
const manualValues = new Map();
let feed = new Map();
let currentCoin = 'RVN';
let lastFetchFailed = false;
// Hourly collection + 15 min scheduling tolerance; 24h hard expiry unchanged.
const REFRESH_MS = 75 * 60 * 1000;
const number = (id,min,max,optional=false) => {
  const raw=byId(id).value.trim();
  if(optional && raw==='') return null;
  if(raw==='') return NaN;
  const x=Number(raw.replace(',','.'));
  return Number.isFinite(x) && x>=min && x<=max ? x : NaN;
};
const networkFields=['powNetworkRate','powNetworkScale','powBlockSeconds','powMinerReward'];
const allFields=['powDeviceRate','powDeviceScale',...networkFields,'powPrice','powAsicWatts','powPearlCoins','powPearlHours'];

function currentConfig(){
  return Object.fromEntries(allFields.map(id=>[id,byId(id).value]));
}
function saveConfig(){manualValues.set(currentCoin,{...currentConfig(),manualOverride:byId('powNetworkRate').dataset.manual==='true'});}
function freshFeed(coin){
  const raw=feed.get(coin);
  return raw ? validateOwnPoWSnapshot(raw) : null;
}
function setNetworkFromFeed(snapshot){
  const scales=[1e15,1e12,1e9,1e6,1e3,1];
  const scale=scales.find(v=>snapshot.networkRate/v>=1&&snapshot.networkRate/v<10000)||1;
  byId('powNetworkScale').value=String(scale);
  byId('powNetworkRate').value=String(Number((snapshot.networkRate/scale).toPrecision(10)));
  byId('powBlockSeconds').value=String(snapshot.blockSeconds);
  byId('powMinerReward').value=String(snapshot.minerRewardCoins);
  byId('powNetworkRate').dataset.manual='false';
}
function switchCoin(coin){
  if(!Object.hasOwn(COINS,coin)||coin==='XMR')return;
  if(currentCoin!==coin)saveConfig();
  currentCoin=coin;
  const saved=manualValues.get(coin);
  const meta=COINS[coin];
  const isPearl=meta.mode==='measured';
  byId('powPearlFields').hidden=!isPearl;
  byId('powHashFields').hidden=isPearl;
  byId('powAsicFields').hidden=!meta.requiresAsic;
  for(const id of allFields)byId(id).value=saved?.[id]||'';
  byId('powNetworkRate').dataset.manual=saved?.manualOverride?'true':'false';
  for(const id of ['powDeviceScale','powNetworkScale']){
    const prefix=meta.unit==='Sol/s'?'Sol':meta.unit==='Graph/s'?'Graph':'H';
    const texts=[prefix+'/s','k'+prefix+'/s','M'+prefix+'/s','G'+prefix+'/s','T'+prefix+'/s','P'+prefix+'/s'];
    [...byId(id).options].forEach((o,i)=>{o.textContent=texts[i];});
    if(!saved)byId(id).value='1';
  }
  byId('powCoin').value=coin;
  byId('powAlgorithm').textContent = meta.algorithm+' · '+meta.hardware+
    (isPearl?' · gains de pool réels': ' · '+meta.unit+' pour le matériel ET le réseau.');
  byId('powHardwareHelp').textContent=meta.requiresAsic?
    'Indiquez le débit réel de votre ASIC en '+meta.unit+' sous '+meta.algorithm+'.':
    'Performance mesurée sous '+meta.algorithm+' pour un seul appareil, jamais reprise d’un autre algorithme.';
  byId('powRewardHelp').textContent=COINS[coin].comment;
  if(!isPearl&&!saved?.manualOverride){
    const snapshot=freshFeed(coin);
    if(snapshot)setNetworkFromFeed(snapshot);
    else for(const id of networkFields.filter(x=>x!=='powNetworkScale'))byId(id).value='';
  }
  updateDevice();
}
function updateDevice(){
  const meta=COINS[currentCoin];
  const selected=byId('deviceSelect').selectedOptions[0];
  byId('powDeviceContext').textContent=meta.requiresAsic?'Type de matériel requis':'Matériel sélectionné sur le calculateur';
  byId('powDevice').textContent=meta.requiresAsic?'ASIC '+meta.algorithm+' (configuration à renseigner)':
    selected?.value?selected.textContent:'Aucun matériel sélectionné';
  render();
}
function reset(message){
  for(const id of ['powDay','powMonth','powYear','powNetDay','powNetMonth','powNetYear'])byId(id).textContent='—';
  byId('powExplanation').textContent=message;
}
function showYield(result,coin,explanation){
  byId('powDay').textContent=crypto.format(result.coinsDay);
  byId('powMonth').textContent=crypto.format(result.coinsMonth30);
  byId('powYear').textContent=crypto.format(result.coinsYear365);
  byId('powNetDay').textContent=result.netEurDay===null?'Cours EUR requis':euro.format(result.netEurDay);
  byId('powNetMonth').textContent=result.netEurMonth30===null?'—':euro.format(result.netEurMonth30);
  byId('powNetYear').textContent=result.netEurYear365===null?'—':euro.format(result.netEurYear365);
  byId('powExplanation').textContent=explanation;
}
function render(){
  const coin=currentCoin;
  const meta=COINS[coin];
  const pearl=meta.mode==='measured';
  const snapshot=pearl?null:freshFeed(coin);
  const manual=byId('powNetworkRate').dataset.manual==='true';
  if(!pearl && !manual && !snapshot){
    // Never calculate from abandoned form values after the 24h cache limit.
    for(const id of networkFields.filter(x=>x!=='powNetworkScale'))byId(id).value='';
  }
  const useNode=!manual&&Boolean(snapshot);
  const saved=useNode && snapshot.source==='public-chain-rpc' &&
    (lastFetchFailed || Date.now()-Date.parse(snapshot.collectedAt)>REFRESH_MS);
  const backup=useNode&&snapshot.usedFallback===true;
  byId('powMode').textContent=pearl?'Gains PRL observés':manual?'Mesures manuelles':
    !useNode?'Service indisponible':saved?'Dernier relevé sauvegardé':
    backup?'Source de secours active':
    snapshot.source==='public-chain-rpc'?'Réseau public · actualisé':'Nœud GPUbnb';
  byId('powObservedAt').textContent=pearl?'PearlHash · mesures brutes du pool':manual?'Saisie manuelle · fraîcheur non vérifiée':
    !useNode?'Aucune mesure réseau valide de moins de 24 h':
    (saved?'Dernière mesure conservée : ':'Mesure : ')+new Date(snapshot.collectedAt).toLocaleString('fr-FR')+
    (saved?' · maximum 24 h':' · '+(snapshot.operator||'source indépendante'));
  for(const [id,suffix] of [['powDayUnit','jour'],['powMonthUnit','mois'],['powYearUnit','an']])
    byId(id).textContent=coin+' / '+suffix;
  const deviceRate=number('powDeviceRate',.000001,1e18)*number('powDeviceScale',1,1e12);
  const networkRate=number('powNetworkRate',.000001,1e25)*number('powNetworkScale',1,1e12);
  const blockSeconds=number('powBlockSeconds',1,7200);
  const minerRewardCoins=number('powMinerReward',1e-18,1e10);
  const quantity=number('quantity',1,100);
  const hours=number('hours',0,24);
  const watts=meta.requiresAsic?number('powAsicWatts',1,20000):number('power',1,1500);
  const electricityEurKwh=number('electricity',0,5);
  const poolFeePercent=number('poolFee',0,100);
  const coinEur=number('powPrice',0,1e7,true);
  if(!meta.requiresAsic && byId('tabCpu').getAttribute('aria-pressed')==='true'){
    reset('Ce profil est destiné à un GPU. Sélectionnez « Carte graphique » en haut du comparateur ou choisissez le calcul Monero pour le CPU.');
    return;
  }
  if(pearl){
    const observedCoins=number('powPearlCoins',0,1e10);
    const observedHours=number('powPearlHours',1,8760);
    const result=estimateMeasuredPayout({coin,observedCoins,observedHours,
      quantity,hours,watts,electricityEurKwh,poolFeePercent,coinEur});
    if(!result){
      reset('Indiquez les PRL bruts réellement observés et la durée exacte pour UN GPU, puis vérifiez les frais et la consommation.');return;
    }
    showYield(result,coin,
      result.netEurDay===null?
      'Projection de gains PRL historiques (pool), pas un rendement prédit. Cours EUR manuel nécessaire pour le net.':
      'Projection historique Pearl (PRL) : prix manuel, coûts et frais déduits. Variance du minage élevée, aucune garantie.');
    return;
  }
  if(!Number.isFinite(deviceRate)||deviceRate<=0){
    reset('Mesurez la performance réelle de votre '+(meta.requiresAsic?'ASIC':'appareil')+' sous '+meta.algorithm+' ('+meta.unit+').');return;
  }
  if(!Number.isFinite(networkRate)||!Number.isFinite(blockSeconds)||!Number.isFinite(minerRewardCoins)){
    reset('Indiquez les mesures du réseau '+coin+' ou utilisez un instantané récent de votre propre nœud.');return;
  }
  const result=estimatePoW({coin,deviceRate,networkRate,blockSeconds,minerRewardCoins,
    quantity,hours,watts,electricityEurKwh,poolFeePercent,coinEur});
  if(!result){
    reset('Vérifiez les unités, la quantité, les paramètres et les valeurs de difficulté du réseau.');return;
  }
  showYield(result,coin,result.netEurDay===null?
    'Espérance mathématique en '+coin+' · '+meta.algorithm+'. Renseignez un cours EUR manuel pour le bénéfice net.':
    'Estimation indicative avec prix manuel, '+quantity+' appareil(s), '+hours+' h/jour, frais et électricité déduits.');
}
async function refresh(){
  try{
    const response=await fetch('data/pow-reseaux.json?t='+Date.now(),{cache:'no-store'});
    if(!response.ok)throw Error('Unavailable');
    const data=await response.json();
    if(!data||data.schemaVersion!==1||!Array.isArray(data.networks)||data.networks.length>50)throw Error('Invalid');
    const next=new Map();
    for(const record of data.networks){
      const item=validateOwnPoWSnapshot(record);
      if(item&&!next.has(item.coin))next.set(item.coin,record);
    }
    // If an individual KV lookup is temporarily empty, keep an earlier *valid*
    // in-memory observation. Never extend its original collectedAt timestamp.
    for(const [coin,previous] of feed){
      if(!next.has(coin) && validateOwnPoWSnapshot(previous))next.set(coin,previous);
    }
    feed=next;
    lastFetchFailed=false;
  }catch{
    // Browser-to-worker outage: retain previous verified values for at most 24h.
    lastFetchFailed=true;
  }
  if(byId('powNetworkRate').dataset.manual!=='true'){
    const snapshot=freshFeed(currentCoin);
    if(snapshot)setNetworkFromFeed(snapshot);
    else if(COINS[currentCoin].mode==='pow')for(const id of ['powNetworkRate','powBlockSeconds','powMinerReward'])byId(id).value='';
  }
  render();
}
byId('powCoin').addEventListener('change',()=>switchCoin(byId('powCoin').value));
for(const id of allFields){
  byId(id).addEventListener('input',()=>{
    if(networkFields.includes(id))byId('powNetworkRate').dataset.manual='true';
    saveConfig();render();
  });
}
for(const id of ['quantity','hours','power','electricity','poolFee'])byId(id).addEventListener('input',render);
byId('deviceSelect').addEventListener('change',updateDevice);
for(const id of ['tabGpu','tabCpu'])byId(id).addEventListener('click',updateDevice);
byId('deviceSearch').addEventListener('input',updateDevice);
switchCoin(currentCoin);
refresh();
setInterval(refresh,5*60*1000);
