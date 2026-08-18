'use strict';

const RENTAL_API=(window.GPUBNB_API_URL||'').replace(/\/$/,'');
const rentalEscape=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));

const machineStateLabels={
  NOT_LINKED:'Host non relié',
  WAITING_FOR_FIRST_HEARTBEAT:'Premier signal en attente',
  OFFLINE:'Host hors ligne',
  GPU_NOT_DETECTED:'GPU non détecté',
  DRIVER_MISSING:'Pilote GPU manquant',
  DOCKER_UNAVAILABLE:'Docker indisponible',
  NVIDIA_RUNTIME_UNAVAILABLE:'Runtime NVIDIA indisponible',
  DIAGNOSTIC_REQUIRED:'Diagnostic GPU requis',
  DIAGNOSTIC_RUNNING:'Diagnostic en cours',
  DIAGNOSTIC_FAILED:'Diagnostic en échec',
  VERIFICATION_REQUIRED:'Vérification Host requise',
  READY_TO_PUBLISH:'Prête à publier',
  LISTING_ACTIVE:'Marketplace actif',
  RESERVED:'Réservée',
  SESSION_STARTING:'Session en démarrage',
  SESSION_ACTIVE:'Session active',
  CLEANUP_REQUIRED:'Nettoyage à vérifier',
  QUARANTINED:'Quarantaine',
};

const gpuBlockLabels={
  ACCELERATOR_NOT_AVAILABLE:'GPU indisponible',
  ACCELERATOR_QUARANTINED:'GPU en quarantaine',
  ISOLATION_NOT_VERIFIED:'Isolation non vérifiée',
  ACCELERATOR_NOT_VERIFIED:'Preuve GPU incomplète',
  ACCELERATOR_STALE:'Télémétrie GPU trop ancienne',
  RESOURCE_AUTHORITY_MISSING:'Ressource GPU non mappée',
  RESOURCE_AUTHORITY_DISABLED:'Ressource GPU désactivée',
  RESOURCE_AUTHORITY_QUARANTINED:'Ressource GPU en quarantaine',
  RESOURCE_AUTHORITY_STALE:'Ressource GPU trop ancienne',
  RESOURCE_RUNTIME_UNSAFE:'Runtime GPU non sûr',
  ACCELERATOR_ALLOCATED:'GPU déjà alloué',
  ACCELERATOR_ALREADY_LISTED:'GPU déjà publié',
  FULL_MACHINE_LISTING_ACTIVE:'Annonce machine entière active',
};

async function rentalRequest(path){
  const response=await fetch(`${RENTAL_API}${path}`,{credentials:'include',headers:{accept:'application/json'}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data.error||`HTTP ${response.status}`);error.status=response.status;throw error}
  return data;
}

function rentalEmpty(root,title,description,href,label){
  root.innerHTML=`<div class="empty-state"><span class="badge warn">Information</span><h2>${rentalEscape(title)}</h2><p class="muted">${rentalEscape(description)}</p>${href?`<a class="button button-primary" href="${rentalEscape(href)}">${rentalEscape(label)}</a>`:''}</div>`;
}

function rentalDate(value){return value?new Date(value).toLocaleString('fr-FR'):'—'}
function solPerHour(lamports){return `${(Number(lamports)/1e9).toFixed(4)} SOL/h`}
function gpuLabel(gpu){return `${gpu.vendor?`${gpu.vendor} `:''}${gpu.model} · ${Math.max(1,Math.round(Number(gpu.vramMiB||0)/1024))} Go`}

async function loadMachineGpus(machineId){
  try{return (await rentalRequest(`/rental/machines/${encodeURIComponent(machineId)}/gpus`)).gpus||[]}
  catch{return []}
}

function renderMachine(machine,gpus){
  const state=machine.state||{};
  const gpuRows=gpus.length?gpus.map(gpu=>{
    const status=gpu.publishable?'Disponible pour une annonce':(gpuBlockLabels[gpu.blockingReason]||gpu.blockingReason||'Non publiable');
    return `<div class="list-row"><div><strong>${rentalEscape(gpuLabel(gpu))}</strong><div class="muted">Pilote ${rentalEscape(gpu.driverVersion||'inconnu')} · CUDA ${rentalEscape(gpu.cudaVersion||'non détectée')} · Dernier signal ${rentalEscape(rentalDate(gpu.lastSeenAt))}</div></div><span class="badge ${gpu.publishable?'ok':'warn'}">${rentalEscape(status)}</span></div>`;
  }).join(''):'<div class="muted">Aucun GPU legacy qualifié n’est encore relié à cette machine.</div>';
  return `<article class="panel" style="margin-bottom:14px"><div class="section-heading"><div><h2>${rentalEscape(machine.gpuModel||'Machine GPUbnb')}</h2><p class="muted">${rentalEscape(machine.operatingSystem||'Système inconnu')}${machine.osVersion?` ${rentalEscape(machine.osVersion)}`:''} · Agent ${rentalEscape(machine.agentVersion||'inconnu')}</p></div><span class="badge ${state.canPublish?'ok':'warn'}">${rentalEscape(machineStateLabels[state.state]||state.state||'État inconnu')}</span></div><div class="muted">Dernier heartbeat : ${rentalEscape(rentalDate(machine.lastHeartbeatAt))} · ${machine.verifiedAt?'Host vérifié':'Host non vérifié'}</div><div class="table-list" style="margin-top:12px">${gpuRows}</div><div class="actions" style="margin-top:12px">${state.canPublish?'<a class="button button-primary" href="publish.html">Publier un GPU disponible</a>':'<a class="button" href="host-install.html">Instructions de résolution</a>'}<a class="button" href="workspaces.html">Espaces de travail</a></div></article>`;
}

async function rentalMachines(){
  const root=document.querySelector('[data-rental-machines]');
  if(!root)return;
  try{
    const data=await rentalRequest('/rental/machines/manage');
    const machines=data.machines||[];
    if(!machines.length)return rentalEmpty(root,'Aucune machine reliée','Installez GPUbnb Host puis reliez votre machine.','host-install.html','Installer GPUbnb Host');
    const withGpus=await Promise.all(machines.map(async machine=>({machine,gpus:await loadMachineGpus(machine.id)})));
    root.innerHTML=withGpus.map(({machine,gpus})=>renderMachine(machine,gpus)).join('');
  }catch(error){
    rentalEmpty(root,'Machines indisponibles',error.status===401?'Connectez-vous pour continuer.':'Impossible de charger l’état serveur des machines.',error.status===401?'auth.html?next=machines.html':null,error.status===401?'Se connecter':null);
  }
}

function renderListing(listing){
  const gpu=listing.gpu;
  const health=listing.health||{};
  const booking=listing.activeBooking;
  const visible=Boolean(health.publiclyVisible);
  const gpuText=gpu?gpuLabel(gpu):'GPU exact non lié';
  const bookingText=booking?`${booking.status} · ${rentalDate(booking.startsAt)} → ${rentalDate(booking.endsAt)}`:'Aucune réservation active';
  return `<article class="list-row machine-detail"><div><strong>${rentalEscape(listing.title)}</strong><div class="muted">${rentalEscape(gpuText)} · ${rentalEscape(solPerHour(listing.hourlyLamports))}</div><div class="muted">État GPU : ${gpu?rentalEscape(gpu.status):'inconnu'} · Runtime ressource : ${rentalEscape(gpu?.resourceRuntimeState||'non disponible')}</div><div class="muted">${rentalEscape(bookingText)}</div><div class="muted">Mise à jour : ${rentalEscape(rentalDate(listing.updatedAt))}</div></div><div><span class="badge ${visible?'ok':'warn'}">${visible?'Visible sur la marketplace':'Non visible'}</span><p class="muted">Statut annonce : ${rentalEscape(listing.status)}</p>${!health.exactAcceleratorLinked?'<p class="muted">Migration requise : aucun GPU exact lié.</p>':''}${health.exactAcceleratorLinked&&!health.gpuHealthy?'<p class="muted">Le GPU exact ne passe plus les contrôles de santé.</p>':''}</div></article>`;
}

async function rentalListings(){
  const root=document.querySelector('[data-rental-listings]');
  if(!root)return;
  try{
    const data=await rentalRequest('/rental/listings/manage');
    const rows=data.listings||[];
    if(!rows.length)return rentalEmpty(root,'Aucune annonce GPU exacte','Publiez un GPU vérifié depuis une machine prête.','publish.html','Publier un GPU');
    root.innerHTML=rows.map(renderListing).join('');
  }catch(error){
    rentalEmpty(root,'Annonces indisponibles',error.status===401?'Connectez-vous pour continuer.':'Impossible de charger les annonces exact-GPU.',error.status===401?'auth.html?next=listings.html':null,error.status===401?'Se connecter':null);
  }
}

document.addEventListener('DOMContentLoaded',()=>{
  rentalMachines();
  rentalListings();
  document.querySelector('[data-rental-check-machines]')?.addEventListener('click',async event=>{
    const button=event.currentTarget;
    button.disabled=true;
    try{await rentalMachines()}finally{button.disabled=false}
  });
});
