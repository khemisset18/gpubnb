'use strict';

const MINING_PROFILES={
  CPU:[{id:'xmrig_randomx',label:'Monero (XMR) · RandomX · XMRig'}],
  GPU:[
    {id:'lolminer_blake3',label:'Alephium (ALPH) · Blake3 · lolMiner',vendors:['NVIDIA']},
    {id:'lolminer_etchash',label:'Ethereum Classic (ETC) · Etchash · lolMiner',vendors:['NVIDIA']},
    {id:'lolminer_octopus',label:'Conflux (CFX) · Octopus · lolMiner',vendors:['NVIDIA']},
  ],
};

const miningStateLabels={IDLE:'Disponible',STARTING:'Démarrage',MINING:'Minage actif',PREEMPTING:'Arrêt pour location',VERIFYING_STOP:'Vérification de l’arrêt',RENTAL_BLOCKED:'Réservée à la location',STOPPED:'Arrêtée',QUARANTINED:'Quarantaine',EMERGENCY_STOPPED:'Arrêt d’urgence'};

function vendorName(value){const text=String(value||'').toUpperCase();if(text.includes('NVIDIA'))return 'NVIDIA';if(text==='AMD'||text.includes('ADVANCED MICRO DEVICES'))return 'AMD';return ''}
function numberValue(form,name,fallback){const value=Number(form.elements[name]?.value);return Number.isFinite(value)?value:fallback}
function profileOptions(resource){const vendor=vendorName(resource.gpuVendor);const profiles=(MINING_PROFILES[resource.kind]||[]).filter(profile=>resource.kind==='CPU'||profile.vendors.includes(vendor));return profiles.map(profile=>`<option value="${escapeHTML(profile.id)}"${profile.id===resource.profileId?' selected':''}>${escapeHTML(profile.label)}</option>`).join('')}
function resourceLocked(resource){return Boolean(resource.activeRentalId||resource.quarantined)}
function statusBadge(resource){if(resource.quarantined)return '<span class="badge danger">Quarantaine</span>';if(resource.activeRentalId)return '<span class="badge warn">Location prioritaire</span>';if(resource.runtimeState==='MINING')return '<span class="badge ok">Minage actif</span>';if(resource.runtimeState==='STARTING'||resource.runtimeState==='VERIFYING_STOP'||resource.runtimeState==='PREEMPTING')return '<span class="badge warn">Transition</span>';return '<span class="badge warn">Inactif</span>'}

function runtimeControls(resource){
  if(resource.kind!=='GPU')return '';
  const transitioning=['STARTING','VERIFYING_STOP','PREEMPTING'].includes(resource.runtimeState);
  const canStart=!resourceLocked(resource)&&resource.mode==='OWNER_POOL'&&!transitioning&&!['MINING','QUARANTINED'].includes(resource.runtimeState);
  const canStop=!resource.activeRentalId&&!resource.quarantined&&!transitioning&&resource.runtimeState==='MINING';
  const startTitle=resource.mode!=='OWNER_POOL'?'Enregistrez d’abord un pool personnel':resource.activeRentalId?'La location est prioritaire':resource.quarantined?'Ressource en quarantaine':transitioning?'Transition en cours':'Démarrer le minage';
  const stopTitle=transitioning?'Transition en cours':'Arrêter le minage';
  return `<section class="mining-runtime-controls"><div class="actions"><button class="button button-primary" type="button" data-start-mining${canStart?'':' disabled'} title="${escapeHTML(startTitle)}">Démarrer le minage</button><button class="button" type="button" data-stop-mining${canStop?'':' disabled'} title="${escapeHTML(stopTitle)}">Arrêter le minage</button></div><p class="muted" data-runtime-status role="status" aria-live="polite">${transitioning?'Commande en cours de traitement…':''}</p></section>`;
}

function renderResource(resource){
  const locked=resourceLocked(resource);
  const mode=resource.mode==='OWNER_POOL'?'OWNER_POOL':'DISABLED';
  const profileChoices=profileOptions(resource);
  const noProfile=mode!=='DISABLED'&&!profileChoices;
  const disabled=locked||noProfile;
  const kindControls=resource.kind==='CPU'
    ? `<div class="field"><label>Threads CPU maximum<input name="cpuThreadLimit" type="number" min="1" max="1024" value="${escapeHTML(resource.cpuThreadCount||1)}" required></label></div><div class="field"><label>Utilisation CPU maximale (%)<input name="cpuUtilizationLimitPercent" type="number" min="1" max="100" value="${escapeHTML(resource.maximumCpuPercent||75)}" required></label></div>`
    : '<p class="muted">Le runtime GPU v1 applique la température et la puissance maximales. Aucun contrôle d’intensité non vérifié n’est exposé.</p>';
  return `<article class="card mining-resource" data-mining-resource="${escapeHTML(resource.id)}"><div class="actions" style="justify-content:space-between"><div><span class="badge">${escapeHTML(resource.kind)}</span> ${statusBadge(resource)}</div><span class="muted">${escapeHTML(miningStateLabels[resource.runtimeState]||resource.runtimeState)}</span></div><h2>${escapeHTML(resource.displayName)}</h2><p class="muted">${resource.kind==='GPU'?`Fournisseur : ${escapeHTML(vendorName(resource.gpuVendor)||'inconnu')} · `:''}Ressource : ${escapeHTML(resource.resourceKey)}</p>${locked?`<p class="muted">${resource.quarantined?'Cette ressource doit être vérifiée avant toute activation.':'Cette ressource est actuellement réservée. La configuration est verrouillée.'}</p>`:''}${noProfile?'<p class="muted">Aucun profil approuvé n’est disponible pour ce matériel.</p>':''}${runtimeControls(resource)}<form data-mining-form data-machine-id="${escapeHTML(resource.machineId)}" data-resource-id="${escapeHTML(resource.id)}" data-resource-kind="${escapeHTML(resource.kind)}" data-version="${escapeHTML(resource.version||0)}"><fieldset${disabled?' disabled':''}><div class="field"><label>Mode<select name="mode"><option value="DISABLED"${mode==='DISABLED'?' selected':''}>Désactivé</option><option value="OWNER_POOL"${mode==='OWNER_POOL'?' selected':''}>Mon pool personnel — commission 0 %</option></select></label></div><div class="field"><label>Profil approuvé<select name="profileId" required>${profileChoices||'<option value="">Aucun profil compatible</option>'}</select></label></div><div class="field"><label>Adresse de portefeuille<input name="walletAddress" maxlength="160" value="${escapeHTML(resource.walletAddress||'')}" placeholder="Adresse de réception"></label></div><div class="field"><label>Nom du worker<input name="workerName" maxlength="64" pattern="[A-Za-z0-9_-]+" value="${escapeHTML(resource.workerName||`gpubnb-${resource.resourceKey}`.replace(/[^A-Za-z0-9_-]/g,'-').slice(0,64))}" required></label></div><div data-owner-pool-fields><div class="field"><label>Endpoint Stratum personnel<input name="ownerPoolEndpoint" maxlength="300" value="${escapeHTML(resource.ownerPoolEndpoint||'')}" placeholder="stratum+ssl://pool.exemple:443"></label></div><div class="field"><label>Référence du secret<input name="ownerPoolSecretRef" maxlength="200" placeholder="secret://local/mining/pool-main"></label><small class="muted">Ne saisissez jamais un mot de passe brut. Utilisez uniquement une référence de secret.</small></div></div><div class="field"><label>Température maximale (°C)<input name="maximumTemperatureC" type="number" min="${resource.kind==='GPU'?85:50}" max="98" value="${escapeHTML(resource.maximumTemperatureC||(resource.kind==='GPU'?85:85))}" required></label><small class="muted">${resource.kind==='GPU'?'Protection GPUbnb : 85–98 °C, 85 °C par défaut.':'Plage CPU autorisée : 50–98 °C.'}</small></div><div class="field"><label>Puissance maximale (W)<input name="maximumPowerWatts" type="number" min="5" max="1500" value="${escapeHTML(resource.maximumPowerWatts||250)}" required></label></div>${kindControls}<label><input name="autoResumeAfterRental" type="checkbox"${resource.autoResumeAfterRental?' checked':''}> Reprendre automatiquement après la location, uniquement après nettoyage vérifié</label><div class="actions" style="margin-top:16px"><button class="button button-primary" type="submit">Enregistrer</button><button class="button" type="button" data-disable-mining>Désactiver rapidement</button></div></fieldset><p class="muted" data-form-status role="status"></p></form></article>`;
}

function syncMode(form){const ownerFields=form.querySelector('[data-owner-pool-fields]');const ownerMode=form.elements.mode.value==='OWNER_POOL';ownerFields.hidden=!ownerMode;ownerFields.querySelectorAll('input').forEach(input=>input.required=ownerMode&&input.name==='ownerPoolEndpoint')}
function configurationPayload(form,forceDisabled=false){const mode=forceDisabled?'DISABLED':form.elements.mode.value;const resourceKind=form.dataset.resourceKind;const payload={mode,resourceKind,resourceId:form.dataset.resourceId,profileId:form.elements.profileId.value,workerName:form.elements.workerName.value.trim(),autoResumeAfterRental:mode==='DISABLED'?false:form.elements.autoResumeAfterRental.checked,maximumTemperatureC:numberValue(form,'maximumTemperatureC',resourceKind==='GPU'?85:85),maximumPowerWatts:numberValue(form,'maximumPowerWatts',250),expectedVersion:Number(form.dataset.version||0)};const wallet=form.elements.walletAddress.value.trim();if(wallet)payload.walletAddress=wallet;if(resourceKind==='CPU'){payload.cpuThreadLimit=numberValue(form,'cpuThreadLimit',1);payload.cpuUtilizationLimitPercent=numberValue(form,'cpuUtilizationLimitPercent',75)}if(mode==='OWNER_POOL'){payload.ownerPoolEndpoint=form.elements.ownerPoolEndpoint.value.trim();const ref=form.elements.ownerPoolSecretRef.value.trim();if(ref)payload.ownerPoolSecretRef=ref}return payload}

async function requestRuntimeAction(card,action){
  const form=card.querySelector('[data-mining-form]');
  const status=card.querySelector('[data-runtime-status]');
  const buttons=card.querySelectorAll('[data-start-mining],[data-stop-mining]');
  buttons.forEach(button=>button.disabled=true);
  status.textContent=action==='start'?'Demande de démarrage…':'Demande d’arrêt…';
  try{
    await request(`/machines/${encodeURIComponent(form.dataset.machineId)}/mining-resources/${encodeURIComponent(form.dataset.resourceId)}/${action}`,{method:'POST'});
    status.textContent=action==='start'?'Démarrage accepté. Vérification de l’Agent en cours…':'Arrêt accepté. Vérification du processus en cours…';
    toast(status.textContent);
    await loadResources(form.dataset.machineId);
  }catch(error){
    status.textContent=error.message;
    toast(error.message,true);
    buttons.forEach(button=>button.disabled=false);
  }
}

async function saveConfiguration(form,forceDisabled=false){const status=form.querySelector('[data-form-status]');const button=form.querySelector('button[type="submit"]');button.disabled=true;status.textContent='Enregistrement…';try{const payload=configurationPayload(form,forceDisabled);const data=await request(`/machines/${encodeURIComponent(form.dataset.machineId)}/mining-resources/${encodeURIComponent(form.dataset.resourceId)}/configuration`,{method:'PUT',body:JSON.stringify(payload)});form.dataset.version=String(data.configuration.version);status.textContent=forceDisabled?'Minage désactivé.':'Configuration enregistrée.';toast(status.textContent);await loadResources(form.dataset.machineId)}catch(error){status.textContent=error.message;toast(error.message,true)}finally{button.disabled=false}}

function bindForms(){
  document.querySelectorAll('[data-mining-form]').forEach(form=>{
    syncMode(form);
    form.elements.mode.addEventListener('change',()=>syncMode(form));
    form.addEventListener('submit',event=>{event.preventDefault();saveConfiguration(form,false)});
    form.querySelector('[data-disable-mining]')?.addEventListener('click',()=>saveConfiguration(form,true));
  });
  document.querySelectorAll('[data-mining-resource]').forEach(card=>{
    card.querySelector('[data-start-mining]')?.addEventListener('click',()=>requestRuntimeAction(card,'start'));
    card.querySelector('[data-stop-mining]')?.addEventListener('click',()=>{
      if(!window.confirm('Arrêter le minage sur ce GPU ?'))return;
      requestRuntimeAction(card,'stop');
    });
  });
}

async function loadResources(machineId){const root=document.querySelector('[data-mining-resources]');root.innerHTML='<article class="card"><h2>Chargement…</h2><p class="muted">Lecture des ressources minières.</p></article>';try{const data=await request(`/machines/${encodeURIComponent(machineId)}/mining-resources`);if(!data.resources.length){root.innerHTML='<article class="card"><h2>Aucune ressource synchronisée</h2><p class="muted">Lancez GPUbnb Host et attendez la synchronisation de l’inventaire CPU/GPU.</p></article>';return}root.innerHTML=data.resources.map(renderResource).join('');bindForms()}catch(error){errorState(root,'Ressources minières indisponibles',error)}}

async function miningPage(){const selector=document.querySelector('[data-mining-machine]');const status=document.querySelector('[data-mining-machine-status]');try{const machines=await request('/machines/mine');if(!machines.length){selector.innerHTML='<option value="">Aucune machine</option>';status.innerHTML='Reliez d’abord une machine avec GPUbnb Host. <a href="host-install.html">Voir l’installation</a>';return}selector.innerHTML=machines.map(machine=>`<option value="${escapeHTML(machine.id)}">${escapeHTML(machine.gpuModel||machine.hostname||machine.id)} · ${escapeHTML(machine.connectivity||'état inconnu')}</option>`).join('');selector.addEventListener('change',()=>loadResources(selector.value));status.textContent='Les réglages sont enregistrés par ressource. Une location verrouille automatiquement la ressource concernée.';await loadResources(selector.value)}catch(error){if(error.status===401){location.replace(`auth.html?next=${encodeURIComponent('mining.html')}`);return}errorState(document.querySelector('[data-mining-resources]'),'Configuration du minage indisponible',error)}}

document.addEventListener('DOMContentLoaded',()=>{if(document.querySelector('[data-mining-page]'))miningPage()});
