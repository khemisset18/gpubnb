/* GPUbnb standalone Monero/RandomX estimator.
   No commercial API; no network or GPU benchmarks are invented.
   All data stays in the browser; own-node feed is optional. */
import { estimateMoneroYield } from './lib/monero-direct.mjs';
import { validateMoneroSnapshot } from './lib/monero-feed.mjs';

const el = id => document.getElementById(id);
const euro = new Intl.NumberFormat('fr-FR', {style:'currency',currency:'EUR',maximumFractionDigits:4});
const xmr = new Intl.NumberFormat('fr-FR', {maximumFractionDigits:12});
let ownNetwork = null;
let ownTimestamp = null;
let feedStatus = 'Aucun instantané de nœud connecté';

function number(id, min, max, optional = false) {
  const value = el(id).value.trim();
  if (optional && !value) return null;
  if (!value) return NaN;
  const n = Number(value.replace(',','.'));
  return Number.isFinite(n) && n >= min && n <= max ? n : NaN;
}

function activeNetwork() {
  if (el('xmrManual').checked) {
    const difficulty = number('xmrDifficulty',1,1e38);
    const rewardXmr = number('xmrReward',0.000001,25);
    if (!Number.isFinite(difficulty) || !Number.isFinite(rewardXmr)) return null;
    return {difficulty,rewardXmr,mode:'manual'};
  }
  if (!ownNetwork || !ownTimestamp ||
    Date.now()-ownTimestamp > 20 * 60000) return null;
  return {...ownNetwork,mode:'node'};
}

function resetResults(message) {
  for (const id of ['xmrDay','xmrMonth','xmrYear','xmrNetDay','xmrNetMonth','xmrNetYear']) el(id).textContent='—';
  el('xmrExplanation').textContent = message;
}

function updateDevice() {
  const selected = el('deviceSelect').selectedOptions[0];
  el('xmrDevice').textContent = selected && selected.value ? selected.textContent : 'Modèle non choisi';
  render();
}

function render() {
  const manual = el('xmrManual').checked;
  el('xmrManualFields').hidden = !manual;
  const network = activeNetwork();
  el('xmrState').textContent = manual ? 'Données réseau manuelles' :
    network ? 'Nœud GPUbnb · 30 blocs' : 'Nœud indisponible';
  el('xmrUpdated').textContent = manual ? 'Saisie utilisateur · fraîcheur non vérifiée' :
    network ? 'Mis à jour : '+new Date(ownTimestamp).toLocaleString('fr-FR') : feedStatus;
  const hash = number('xmrHashrate', 0.001, 1e9);
  if (!network) {
    resetResults(manual ? 'Entrez une difficulté et une récompense réelles de votre nœud.' :
      'Réseau indisponible : utilisez un nœud Monero local ou la saisie manuelle.');
    return;
  }
  if (!Number.isFinite(hash)) {
    resetResults('Saisissez le hashrate RandomX réellement mesuré pour ce matériel (H/s).');
    return;
  }
  const price = number('xmrPrice',0.000001,1e7,true);
  const quantity = number('quantity',1,100);
  const hours = number('hours',0,24);
  const watts = number('power',1,1500);
  const electricity = number('electricity',0,5);
  const poolFee = number('poolFee',0,100);
  if (![quantity,hours,watts,electricity,poolFee].every(Number.isFinite) ||
    !Number.isInteger(quantity) || Number.isNaN(price)) {
    resetResults('Corrigez les champs de puissance, d’électricité, de quantité et de frais.');
    return;
  }
  try {
    const value = estimateMoneroYield({
      network, hashrateHps:hash, quantity, hoursPerDay:hours,
      wattsPerDevice:watts, electricityEurKwh:electricity,
      poolFeePercent:poolFee,xmrEur:price
    });
    el('xmrDay').textContent = xmr.format(value.expectedXmrDay);
    el('xmrMonth').textContent = xmr.format(value.expectedXmrMonth30);
    el('xmrYear').textContent = xmr.format(value.expectedXmrYear365);
    el('xmrNetDay').textContent = value.netEurDay === null ? 'Cours EUR requis' : euro.format(value.netEurDay);
    el('xmrNetMonth').textContent = value.netEurMonth30 === null ? '—' : euro.format(value.netEurMonth30);
    el('xmrNetYear').textContent = value.netEurYear365 === null ? '—' : euro.format(value.netEurYear365);
    el('xmrExplanation').textContent = value.netEurDay === null ?
      'XMR théoriques calculés. Pour le bénéfice en €, entrez un cours XMR/EUR manuel. Le coût de l’électricité n’est pas déduit des quantités en XMR.' :
      'Calcul avec prix XMR saisi manuellement, '+quantity+' appareil(s), '+hours+' h/jour, électricité et frais de pool déduits.';
  } catch {
    resetResults('Les valeurs saisies ne permettent pas un calcul fiable.');
  }
}

async function updateNetwork() {
  try {
    const response = await fetch('data/monero-reseau.json?t='+Date.now(),{cache:'no-store'});
    if (!response.ok) throw Error('Snapshot missing');
    const parsed = validateMoneroSnapshot(await response.json());
    if (!parsed) throw Error('No valid own-node snapshot');
    ownNetwork = parsed;
    ownTimestamp = Date.parse(parsed.collectedAt);
    feedStatus = 'Réseau vérifié';
  } catch {
    ownNetwork = null; ownTimestamp = null;
    feedStatus = 'Aucun instantané récent du nœud GPUbnb';
  }
  render();
}
for (const id of ['xmrHashrate','xmrPrice','xmrDifficulty','xmrReward','xmrManual',
                   'quantity','hours','power','electricity','poolFee']) {
  el(id).addEventListener(id==='xmrManual'?'change':'input',render);
}
for (const id of ['deviceSelect','tabGpu','tabCpu','deviceSearch']) {
  el(id).addEventListener(id.startsWith('tab')?'click':id==='deviceSelect'?'change':'input',updateDevice);
}
updateDevice();
updateNetwork();
setInterval(updateNetwork,5*60*1000);
