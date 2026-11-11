/* Independent GPUbnb GPU PoW estimator. No commercial sources, no fabricated benchmarks. */
import { COINS, estimatePoW, validateOwnPoWSnapshot } from './lib/pow-yield.mjs';

const byId = id => document.getElementById(id);
const euro = new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:4});
const crypto = new Intl.NumberFormat('fr-FR',{maximumFractionDigits:10});
const manualValues = new Map();
let feed = new Map();
let currentCoin = 'RVN';
const number = (id,min,max,optional=false) => {
  const raw=byId(id).value.trim();
  if(optional && raw==='') return null;
  if(raw==='') return NaN;
  const x=Number(raw.replace(',','.'));
  return Number.isFinite(x) && x>=min && x<=max ? x : NaN;
};
const networkFields=['powNetworkRate','powNetworkScale','powBlockSeconds','powMinerReward'];
const allFields=['powDeviceRate','powDeviceScale',...networkFields,'powPrice'];

function currentConfig(){
  return Object.fromEntries(allFields.map(id=>[id,byId(id).value]));
}
function saveConfig(){manualValues.set(currentCoin,{...currentConfig(),manualOverride:byId('powNetworkRate').dataset.manual==='true'});}
function freshFeed(coin){
  const raw=feed.get(coin);
  return raw ? validateOwnPoWSnapshot(raw) : null;
}
function setNetworkFromFeed(snapshot){
  const scales=[1e12,1e9,1e6,1e3,1];
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
  for(const id of allFields)byId(id).value=saved?.[id]||'';
  byId('powNetworkRate').dataset.manual=saved?.manualOverride?'true':'false';
  for(const id of ['powDeviceScale','powNetworkScale']){
    const isFlux=coin==='FLUX';
    const prefix=isFlux?'Sol':'H';
    const texts=[prefix+'/s','k'+prefix+'/s','M'+prefix+'/s','G'+prefix+'/s','T'+prefix+'/s'];
    [...byId(id).options].forEach((o,i)=>{o.textContent=texts[i];});
    if(!saved)byId(id).value='1';
  }
  byId('powCoin').value=coin;
  byId('powAlgorithm').textContent = COINS[coin].algorithm+' · '+COINS[coin].hardware+' · '+COINS[coin].unit+' pour le matériel ET le réseau.';
  byId('powHardwareHelp').textContent='Hashrate mesuré sous '+COINS[coin].algorithm+' pour un appareil, jamais repris d’un autre algorithme.';
  byId('powRewardHelp').textContent=COINS[coin].comment;
  if(!saved?.manualOverride){
    const snapshot=freshFeed(coin);
    if(snapshot)setNetworkFromFeed(snapshot);
    else for(const id of networkFields.filter(x=>x!=='powNetworkScale'))byId(id).value='';
  }
  updateDevice();
}
function updateDevice(){
  const selected=byId('deviceSelect').selectedOptions[0];
  byId('powDevice').textContent=selected?.value?selected.textContent:'Aucun matériel sélectionné';
  render();
}
function reset(message){
  for(const id of ['powDay','powMonth','powYear','powNetDay','powNetMonth','powNetYear'])byId(id).textContent='—';
  byId('powExplanation').textContent=message;
}
function render(){
  const coin=currentCoin;
  const snapshot=freshFeed(coin);
  const manual=byId('powNetworkRate').dataset.manual==='true';
  if(!manual && !snapshot && feed.has(coin)){
    for(const id of networkFields.filter(x=>x!=='powNetworkScale'))byId(id).value='';
  }
  const useNode=!manual&&Boolean(snapshot);
  byId('powMode').textContent=useNode?'Nœud GPUbnb vérifié':'Réseau manuel';
  byId('powObservedAt').textContent=useNode?
    'Observation propre : '+new Date(snapshot.collectedAt).toLocaleString('fr-FR'):
    'Saisie manuelle, non vérifiée en temps réel';
  for(const [id,suffix] of [['powDayUnit','jour'],['powMonthUnit','mois'],['powYearUnit','an']])
    byId(id).textContent=coin+' / '+suffix;
  const deviceRate=number('powDeviceRate',.000001,1e18)*number('powDeviceScale',1,1e12);
  const networkRate=number('powNetworkRate',.000001,1e25)*number('powNetworkScale',1,1e12);
  const blockSeconds=number('powBlockSeconds',1,7200);
  const minerRewardCoins=number('powMinerReward',1e-18,1e10);
  const quantity=number('quantity',1,100);
  const hours=number('hours',0,24);
  const watts=number('power',1,1500);
  const electricityEurKwh=number('electricity',0,5);
  const poolFeePercent=number('poolFee',0,100);
  const coinEur=number('powPrice',0,1e7,true);
  if(!Number.isFinite(deviceRate)||deviceRate<=0){
    reset('Mesurez le hashrate réel de votre appareil sous '+COINS[coin].algorithm+' et indiquez sa valeur.');return;
  }
  if(!Number.isFinite(networkRate)||!Number.isFinite(blockSeconds)||!Number.isFinite(minerRewardCoins)){
    reset('Indiquez les mesures du réseau '+coin+' ou utilisez un instantané récent de votre propre nœud.');return;
  }
  const result=estimatePoW({coin,deviceRate,networkRate,blockSeconds,minerRewardCoins,
    quantity,hours,watts,electricityEurKwh,poolFeePercent,coinEur});
  if(!result){
    reset('Vérifiez les unités, la quantité, les paramètres et les valeurs de difficulté du réseau.');return;
  }
  byId('powDay').textContent=crypto.format(result.coinsDay);
  byId('powMonth').textContent=crypto.format(result.coinsMonth30);
  byId('powYear').textContent=crypto.format(result.coinsYear365);
  byId('powNetDay').textContent=result.netEurDay===null?'Cours EUR requis':euro.format(result.netEurDay);
  byId('powNetMonth').textContent=result.netEurMonth30===null?'—':euro.format(result.netEurMonth30);
  byId('powNetYear').textContent=result.netEurYear365===null?'—':euro.format(result.netEurYear365);
  byId('powExplanation').textContent=result.netEurDay===null?
    'Espérance théorique en '+coin+'. Renseignez un cours en euros manuel pour estimer le bénéfice net après électricité et pool.':
    'Bénéfice indicatif calculé avec votre prix manuel, '+quantity+' appareil(s), '+hours+' h/jour, frais de pool et électricité déduits.';
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
    feed=next;
  }catch{feed=new Map();}
  if(byId('powNetworkRate').dataset.manual!=='true'){
    const snapshot=freshFeed(currentCoin);
    if(snapshot)setNetworkFromFeed(snapshot);
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
for(const id of ['tabGpu','tabCpu','deviceSearch'])byId(id).addEventListener('click',updateDevice);
switchCoin(currentCoin);
refresh();
setInterval(refresh,5*60*1000);
