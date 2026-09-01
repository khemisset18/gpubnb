'use strict';

const RENTAL_API=(window.GPUBNB_API_URL||'').replace(/\/$/,'');
const rentalEscape=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));

const machineStateLabels={
  NOT_LINKED:'Host non relié',WAITING_FOR_FIRST_HEARTBEAT:'Premier signal en attente',OFFLINE:'Host hors ligne',AGENT_OUTDATED:'Agent obsolète — mise à jour requise',GPU_NOT_DETECTED:'GPU non détecté',DRIVER_MISSING:'Pilote GPU manquant',DOCKER_UNAVAILABLE:'Docker indisponible',NVIDIA_RUNTIME_UNAVAILABLE:'Runtime NVIDIA indisponible',DIAGNOSTIC_REQUIRED:'Diagnostic GPU requis',DIAGNOSTIC_RUNNING:'Diagnostic en cours',DIAGNOSTIC_FAILED:'Diagnostic en échec',VERIFICATION_REQUIRED:'Vérification Host requise',READY_TO_PUBLISH:'Prête à publier',LISTING_ACTIVE:'Marketplace actif',RESERVED:'Réservée',SESSION_STARTING:'Session en démarrage',SESSION_ACTIVE:'Session active',CLEANUP_REQUIRED:'Nettoyage à vérifier',QUARANTINED:'Quarantaine',
};
const gpuBlockLabels={
  ACCELERATOR_NOT_AVAILABLE:'GPU indisponible',ACCELERATOR_QUARANTINED:'GPU en quarantaine',ISOLATION_NOT_VERIFIED:'Isolation non vérifiée',ACCELERATOR_NOT_VERIFIED:'Preuve GPU incomplète',ACCELERATOR_STALE:'Télémétrie GPU trop ancienne',RESOURCE_AUTHORITY_MISSING:'Ressource GPU non mappée',RESOURCE_AUTHORITY_DISABLED:'Ressource GPU désactivée',RESOURCE_AUTHORITY_QUARANTINED:'Ressource GPU en quarantaine',RESOURCE_AUTHORITY_STALE:'Ressource GPU trop ancienne',RESOURCE_RUNTIME_UNSAFE:'Runtime GPU non sûr',ACCELERATOR_ALLOCATED:'GPU déjà alloué',ACCELERATOR_ALREADY_LISTED:'GPU déjà publié',FULL_MACHINE_LISTING_ACTIVE:'Annonce machine entière active',
};
const machineBlockLabels={
  NO_AGENT_PUBLIC_KEY:'Aucun Host relié',NO_HEARTBEAT_RECEIVED:'Aucun signal reçu',HEARTBEAT_STALE_OR_OFFLINE:'Host hors ligne ou signal trop ancien',NO_GPU_INVENTORY:'Aucun GPU détecté',GPU_DRIVER_MISSING:'Pilote GPU manquant',DOCKER_UNAVAILABLE:'Docker indisponible',NVIDIA_RUNTIME_UNAVAILABLE:'Runtime NVIDIA indisponible',GPU_DIAGNOSTIC_REQUIRED:'Diagnostic GPU requis',DIAGNOSTIC_FAILED:'Dernier diagnostic en échec',HOST_NOT_VERIFIED:'Host non vérifié',CLEANUP_NOT_VERIFIED:'Nettoyage non vérifié',RESOURCE_QUARANTINED:'Machine en quarantaine (raison non détaillée)',
  CRITICAL_GPU_IDENTITY_CHANGE:"Changement critique d'identité GPU pendant une session",DIAGNOSTIC_COMPLETION_RACE:'Session active après libération de la ressource GPU',STALE_CLAIM:'Revendication de ressource GPU non prouvée',STALE_JOB:"Tâche agent restée bloquée sans confirmation",WORKSPACE_CLEANUP_FAILED:'Nettoyage de Workspace non confirmé',AGENT_SECURITY_FAILURE:'Échecs de signature agent répétés',GPU_HEALTH_CHECK_FAILED:'Le diagnostic GPU a échoué',ORPHANED_ALLOCATION:'Allocation GPU orpheline détectée',GPU_UNAVAILABLE:'Aucun GPU détecté',UNKNOWN:'Cause non déterminée',
};
const listingActionErrors={
  listing_has_live_booking:'Une réservation engagée existe encore. L’archive est bloquée jusqu’à sa fin ou son annulation.',
  machine_not_ready:'La machine doit être en ligne et récente avant de reprendre cette annonce.',
  accelerator_not_ready:'Le GPU exact ne passe pas actuellement tous les contrôles de sécurité et de disponibilité.',
  invalid_listing_transition:'Cette action n’est pas autorisée depuis l’état actuel de l’annonce.',
  invalid_listing_mode:'Cette ancienne annonce n’utilise pas encore le mode GPU exact.',
  listing_conflict:'L’état a changé en même temps. Rechargez la page puis réessayez.',
};

async function rentalRequest(path,options={}){
  const headers={accept:'application/json',...(options.headers||{})};
  if(options.body!==undefined&&!('content-type' in headers)&&!('Content-Type' in headers))headers['content-type']='application/json';
  const response=await fetch(`${RENTAL_API}${path}`,{credentials:'include',...options,headers});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data.error||`HTTP ${response.status}`);error.status=response.status;error.data=data;throw error}
  return data;
}
function rentalEmpty(root,title,description,href,label){root.innerHTML=`<div class="empty-state"><span class="badge warn">Information</span><h2>${rentalEscape(title)}</h2><p class="muted">${rentalEscape(description)}</p>${href?`<a class="button button-primary" href="${rentalEscape(href)}">${rentalEscape(label)}</a>`:''}</div>`}
function rentalDate(value){return value?new Date(value).toLocaleString('fr-FR'):'—'}
function solPerHour(lamports){return `${(Number(lamports)/1e9).toFixed(4)} SOL/h`}
function gpuLabel(gpu){return `${gpu.vendor?`${gpu.vendor} `:''}${gpu.model} · ${Math.max(1,Math.round(Number(gpu.vramMiB||0)/1024))} Go`}
function rentalFeedback(text,error=false){
  const root=document.querySelector('[data-rental-listings]');if(!root)return;
  let box=document.querySelector('[data-rental-feedback]');
  if(!box){box=document.createElement('div');box.dataset.rentalFeedback='';box.setAttribute('role','status');box.setAttribute('aria-live','polite');root.parentElement?.insertBefore(box,root)}
  box.className=`form-message ${error?'error':'success'}`;box.textContent=text;
}
async function loadMachineGpus(machineId){try{return (await rentalRequest(`/rental/machines/${encodeURIComponent(machineId)}/gpus`)).gpus||[]}catch{return []}}

function renderMachine(machine,gpus){
  const state=machine.state||{};
  const gpuRows=gpus.length?gpus.map(gpu=>{const status=gpu.publishable?'Disponible pour une annonce':(gpuBlockLabels[gpu.blockingReason]||gpu.blockingReason||'Non publiable');return `<div class="list-row"><div><strong>${rentalEscape(gpuLabel(gpu))}</strong><div class="muted">Pilote ${rentalEscape(gpu.driverVersion||'inconnu')} · CUDA ${rentalEscape(gpu.cudaVersion||'non détectée')} · Dernier signal ${rentalEscape(rentalDate(gpu.lastSeenAt))}</div></div><span class="badge ${gpu.publishable?'ok':'warn'}">${rentalEscape(status)}</span></div>`}).join(''):'<div class="muted">Aucun GPU legacy qualifié n’est encore relié à cette machine.</div>';
  const isQuarantined=state.state==='QUARANTINED';
  const reasonLine=state.blockingReason?`<div class="muted"><strong>${isQuarantined?'Cause de la quarantaine':'Raison'} :</strong> ${rentalEscape(machineBlockLabels[state.blockingReason]||state.blockingReason)}</div>`:'';
  const daysSince=machine.lastHeartbeatAt?Math.floor((Date.now()-new Date(machine.lastHeartbeatAt).getTime())/86400000):null;
  const staleNotice=machine.lifecycleStatus==='STALE'?`<div class="muted">⚪ Machine inactive depuis ${daysSince??'plusieurs'} jours (dernier signal : ${rentalEscape(rentalDate(machine.lastHeartbeatAt))}).</div>`:'';
  const retireButton=machine.lifecycleStatus==='STALE'?`<button class="button" type="button" data-retire-machine="${rentalEscape(machine.id)}">Retirer cette machine</button>`:'';
  return `<article class="panel" style="margin-bottom:14px"><div class="section-heading"><div><h2>${rentalEscape(machine.gpuModel||'Machine GPUbnb')}</h2><p class="muted">${rentalEscape(machine.operatingSystem||'Système inconnu')}${machine.osVersion?` ${rentalEscape(machine.osVersion)}`:''} · Agent ${rentalEscape(machine.agentVersion||'inconnu')}</p></div><span class="badge ${isQuarantined?'danger':state.canPublish?'ok':'warn'}">${rentalEscape(machineStateLabels[state.state]||state.state||'État inconnu')}</span></div><div class="muted">Dernier heartbeat : ${rentalEscape(rentalDate(machine.lastHeartbeatAt))} · ${machine.verifiedAt?'Host vérifié':'Host non vérifié'}</div>${reasonLine}${staleNotice}<div class="table-list" style="margin-top:12px">${gpuRows}</div><div class="actions" style="margin-top:12px">${state.canPublish?`<a class="button button-primary" href="publish.html?machineId=${encodeURIComponent(machine.id)}">Publier un GPU disponible</a>`:''}<a class="button${isQuarantined?' button-primary':''}" href="machine-diagnostics.html?machineId=${encodeURIComponent(machine.id)}">${isQuarantined?'Voir la quarantaine et diagnostiquer':'État & diagnostics'}</a><a class="button" href="workspaces.html">Espaces de travail</a>${retireButton}</div></article>`;
}
async function rentalMachines(){
  const root=document.querySelector('[data-rental-machines]');if(!root)return;
  try{const data=await rentalRequest('/rental/machines/manage');const machines=data.machines||[];if(!machines.length)return rentalEmpty(root,'Aucune machine reliée','Installez GPUbnb Host puis reliez votre machine.','host-install.html','Installer GPUbnb Host');const withGpus=await Promise.all(machines.map(async machine=>({machine,gpus:await loadMachineGpus(machine.id)})));root.innerHTML=withGpus.map(({machine,gpus})=>renderMachine(machine,gpus)).join('')}catch(error){rentalEmpty(root,'Machines indisponibles',error.status===401?'Connectez-vous pour continuer.':'Impossible de charger l’état serveur des machines.',error.status===401?'auth.html?next=machines.html':null,error.status===401?'Se connecter':null)}
}

function listingActions(listing){
  if(['ACTIVE','RESERVED','HIDDEN_OFFLINE'].includes(listing.status))return `<div class="actions"><button class="button" type="button" data-listing-action="pause" data-listing-id="${rentalEscape(listing.id)}">Mettre en pause</button><button class="button" type="button" data-listing-action="archive" data-listing-id="${rentalEscape(listing.id)}">Archiver</button></div>`;
  if(listing.status==='PAUSED')return `<div class="actions"><button class="button button-primary" type="button" data-listing-action="resume" data-listing-id="${rentalEscape(listing.id)}">Reprendre</button><button class="button" type="button" data-listing-action="archive" data-listing-id="${rentalEscape(listing.id)}">Archiver</button></div>`;
  if(['DRAFT','PENDING_GPU_VERIFICATION'].includes(listing.status))return `<div class="actions"><button class="button" type="button" data-listing-action="archive" data-listing-id="${rentalEscape(listing.id)}">Archiver</button></div>`;
  return '';
}
function renderListing(listing){
  const gpu=listing.gpu,health=listing.health||{},booking=listing.activeBooking,visible=Boolean(health.publiclyVisible);const gpuText=gpu?gpuLabel(gpu):'GPU exact non lié';const bookingText=booking?`${booking.status} · ${rentalDate(booking.startsAt)} → ${rentalDate(booking.endsAt)}`:'Aucune réservation active';
  return `<article class="list-row machine-detail"><div><strong>${rentalEscape(listing.title)}</strong><div class="muted">${rentalEscape(gpuText)} · ${rentalEscape(solPerHour(listing.hourlyLamports))}</div><div class="muted">État GPU : ${gpu?rentalEscape(gpu.status):'inconnu'} · Runtime ressource : ${rentalEscape(gpu?.resourceRuntimeState||'non disponible')}</div><div class="muted">${rentalEscape(bookingText)}</div><div class="muted">Mise à jour : ${rentalEscape(rentalDate(listing.updatedAt))}</div></div><div><span class="badge ${visible?'ok':'warn'}">${visible?'Visible sur la marketplace':'Non visible'}</span><p class="muted">Statut annonce : ${rentalEscape(listing.status)}</p>${!health.exactAcceleratorLinked?'<p class="muted">Migration requise : aucun GPU exact lié.</p>':''}${health.exactAcceleratorLinked&&!health.gpuHealthy?'<p class="muted">Le GPU exact ne passe plus les contrôles de santé.</p>':''}${listingActions(listing)}</div></article>`;
}
async function rentalListings(){
  const root=document.querySelector('[data-rental-listings]');if(!root)return;
  try{const data=await rentalRequest('/rental/listings/manage');const rows=data.listings||[];if(!rows.length)return rentalEmpty(root,'Aucune annonce GPU exacte','Publiez un GPU vérifié depuis une machine prête.','publish.html','Publier un GPU');root.innerHTML=rows.map(renderListing).join('')}catch(error){rentalEmpty(root,'Annonces indisponibles',error.status===401?'Connectez-vous pour continuer.':'Impossible de charger les annonces exact-GPU.',error.status===401?'auth.html?next=listings.html':null,error.status===401?'Se connecter':null)}
}
async function runListingAction(button){
  const action=button.dataset.listingAction,id=button.dataset.listingId;if(!action||!id)return;
  if(action==='archive'&&!window.confirm('Archiver cette annonce ? Elle ne sera plus réactivée automatiquement.'))return;
  const original=button.textContent;button.disabled=true;button.textContent='Traitement…';
  try{await rentalRequest(`/rental/listings/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,{method:'POST',body:'{}'});rentalFeedback(action==='pause'?'Annonce mise en pause.':action==='resume'?'Annonce remise en ligne.':'Annonce archivée.');await rentalListings()}catch(error){rentalFeedback(listingActionErrors[error.data?.error]||`Action refusée : ${error.data?.error||error.message}`,true);button.disabled=false;button.textContent=original}
}

async function runRetireMachine(button){
  const machineId=button.dataset.retireMachine;if(!machineId)return;
  if(!window.confirm('Retirer cette machine inactive ? Elle ne sera plus proposée à la location. Son historique est conservé et un administrateur peut la réactiver.'))return;
  button.disabled=true;const original=button.textContent;button.textContent='Retrait…';
  try{await rentalRequest(`/rental/machines/${encodeURIComponent(machineId)}/retire`,{method:'POST',body:JSON.stringify({reason:'Retirée par le propriétaire depuis Mes machines (inactive).'})});rentalFeedback('Machine retirée.');await rentalMachines()}catch(error){rentalFeedback(`Retrait impossible : ${error.data?.error||error.message}`,true);button.disabled=false;button.textContent=original}
}

document.addEventListener('DOMContentLoaded',()=>{
  rentalMachines();rentalListings();
  document.querySelector('[data-rental-check-machines]')?.addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{await rentalMachines()}finally{button.disabled=false}});
  document.querySelector('[data-rental-listings]')?.addEventListener('click',event=>{const button=event.target.closest?.('[data-listing-action]');if(button)runListingAction(button)});
  document.querySelector('[data-rental-machines]')?.addEventListener('click',event=>{const button=event.target.closest?.('[data-retire-machine]');if(button)runRetireMachine(button)});
});
