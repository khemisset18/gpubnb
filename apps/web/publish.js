'use strict';
const API=(window.GPUBNB_CONFIG?.apiBase||'').replace(/\/$/,'');
const form=document.querySelector('#publishForm');
const message=document.querySelector('#formMessage');
const description=form.elements.description;
const descriptionCount=document.querySelector('#descriptionCount');
const machineSelect=form.elements.machineId;
const gpuSelect=form.elements.acceleratorId;
const submitButton=document.querySelector('#publishSubmit');
const machineState=document.querySelector('#machineState');
const gpuState=document.querySelector('#gpuState');
let machines=[];

const BLOCKING_REASON={
  ACCELERATOR_NOT_AVAILABLE:'GPU temporairement indisponible',
  ACCELERATOR_QUARANTINED:'GPU en quarantaine de sécurité',
  ISOLATION_NOT_VERIFIED:'isolation GPU non vérifiée',
  ACCELERATOR_NOT_VERIFIED:'preuve GPU incomplète',
  ACCELERATOR_STALE:'télémétrie GPU trop ancienne',
  RESOURCE_AUTHORITY_MISSING:'autorité de ressource GPU absente',
  RESOURCE_AUTHORITY_DISABLED:'ressource GPU désactivée',
  RESOURCE_AUTHORITY_QUARANTINED:'ressource GPU en quarantaine',
  RESOURCE_AUTHORITY_STALE:'autorité de ressource trop ancienne',
  RESOURCE_RUNTIME_UNSAFE:'runtime GPU non sûr pour une location',
  ACCELERATOR_ALLOCATED:'GPU déjà alloué à une réservation',
  ACCELERATOR_ALREADY_LISTED:'GPU déjà publié',
  FULL_MACHINE_LISTING_ACTIVE:'une annonce machine entière utilise déjà ce GPU',
};
const MACHINE_STATE={
  NOT_LINKED:'Host non relié',
  WAITING_FOR_FIRST_HEARTBEAT:'premier heartbeat en attente',
  OFFLINE:'Host hors ligne',
  GPU_NOT_DETECTED:'aucun GPU détecté',
  DRIVER_MISSING:'pilote GPU manquant',
  DOCKER_UNAVAILABLE:'Docker indisponible',
  NVIDIA_RUNTIME_UNAVAILABLE:'runtime NVIDIA indisponible',
  DIAGNOSTIC_REQUIRED:'diagnostic GPU requis',
  DIAGNOSTIC_RUNNING:'diagnostic en cours',
  DIAGNOSTIC_FAILED:'diagnostic en échec',
  VERIFICATION_REQUIRED:'vérification Host requise',
  READY_TO_PUBLISH:'prête à publier',
  LISTING_ACTIVE:'machine active sur le marketplace',
  RESERVED:'machine réservée',
  SESSION_STARTING:'session en démarrage',
  SESSION_ACTIVE:'session active',
  CLEANUP_REQUIRED:'nettoyage à vérifier',
  QUARANTINED:'machine en quarantaine',
};

async function api(path,options={}){
  const headers={accept:'application/json',...(options.headers||{})};
  if(options.body!==undefined&&!('content-type' in headers)&&!('Content-Type' in headers))headers['content-type']='application/json';
  const r=await fetch(`${API}${path}`,{credentials:'include',...options,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(data.error||`HTTP ${r.status}`);e.status=r.status;e.data=data;throw e}
  return data;
}
function show(text,error=false){message.textContent=text;message.className=`form-message ${error?'error':'success'}`}
function value(name){return String(form.elements[name].value||'').trim()}
function updateSubmitReady(){submitButton.disabled=!(machineSelect.value&&gpuSelect.value)}
function humanMachineState(machine){return MACHINE_STATE[machine?.state?.state]||machine?.state?.state||'état inconnu'}
function humanGpuBlock(reason){return BLOCKING_REASON[reason]||reason||'GPU non publiable'}
function gpuMemory(vramMiB){return Number.isFinite(vramMiB)?`${Math.max(1,Math.round(vramMiB/1024))} Go`:'VRAM inconnue'}

async function loadGpus(machineId){
  gpuSelect.disabled=true;
  gpuSelect.replaceChildren(new Option('Vérification des GPU…',''));
  gpuState.textContent='Contrôle du GPU physique et de son autorité de ressource…';
  updateSubmitReady();
  if(!machineId){
    gpuSelect.replaceChildren(new Option('Choisissez d’abord une machine',''));
    gpuState.textContent='Le serveur vérifiera le GPU exact avant publication.';
    return;
  }
  try{
    const data=await api(`/rental/machines/${encodeURIComponent(machineId)}/gpus`);
    gpuSelect.replaceChildren();
    gpuSelect.add(new Option('Choisir un GPU vérifié',''));
    let available=0;
    for(const gpu of data.gpus||[]){
      const base=`${gpu.vendor?`${gpu.vendor} `:''}${gpu.model} · ${gpuMemory(gpu.vramMiB)}`;
      const label=gpu.publishable?`${base} · Disponible`:`${base} · Bloqué : ${humanGpuBlock(gpu.blockingReason)}`;
      const option=new Option(label,gpu.id);
      option.disabled=!gpu.publishable;
      gpuSelect.add(option);
      if(gpu.publishable)available+=1;
    }
    if(!(data.gpus||[]).length){
      gpuSelect.add(new Option('Aucun GPU inventorié',''));
      gpuState.textContent='Aucun GPU physique n’est encore disponible dans l’inventaire de location.';
      return;
    }
    if(!available){
      gpuState.textContent='Aucun GPU de cette machine ne passe actuellement tous les contrôles de publication.';
      return;
    }
    gpuSelect.disabled=false;
    gpuState.textContent=`${available} GPU${available>1?'s':''} vérifié${available>1?'s':''} et publiable${available>1?'s':''}.`;
  }catch(e){
    gpuSelect.replaceChildren(new Option('GPU indisponibles',''));
    gpuState.textContent=e.status===404?'Machine introuvable ou non autorisée.':'Impossible de vérifier les GPU de cette machine.';
  }finally{updateSubmitReady()}
}

async function loadAccount(){
  submitButton.disabled=true;
  machineSelect.disabled=true;
  gpuSelect.disabled=true;
  try{
    const me=await api('/auth/me');
    document.querySelector('#accountState').textContent=`Connecté : ${me.user.pseudonym}`;
    if(!me.user.canHost){
      machineState.textContent='Activez le rôle propriétaire avant de publier.';
      show('Le rôle propriétaire est requis.',true);
      return;
    }
    const data=await api('/rental/machines/manage');
    machines=data.machines||[];
    machineSelect.replaceChildren();
    if(!machines.length){
      machineSelect.add(new Option('Aucune machine reliée',''));
      machineState.textContent='Aucune machine reliée. Installez GPUbnb Host puis créez un code de liaison.';
      show('Reliez d’abord une machine avec GPUbnb Host.',true);
      return;
    }
    machineSelect.add(new Option('Choisir une machine',''));
    let eligible=0;
    for(const machine of machines){
      const ready=Boolean(machine.state?.canPublish);
      const model=machine.gpuModel||'GPU en détection';
      const label=`${model} · ${humanMachineState(machine)}`;
      const option=new Option(label,machine.id);
      option.disabled=!ready;
      machineSelect.add(option);
      if(ready)eligible+=1;
    }
    machineSelect.disabled=false;
    machineState.textContent=eligible
      ?`${eligible} machine${eligible>1?'s':''} prête${eligible>1?'s':''} pour sélectionner un GPU.`
      :'Aucune machine ne passe actuellement les contrôles de publication.';
    if(!eligible)show('Corrigez l’état du Host avant de publier un GPU.',true);
    await loadGpus('');
  }catch(e){
    if(e.status===401){location.href='/auth.html?next=publish';return}
    machineSelect.replaceChildren(new Option('Machines indisponibles',''));
    machineState.textContent='Impossible de charger l’état de location des machines.';
    show('Impossible de charger le compte ou les machines.',true);
  }
}

description.addEventListener('input',()=>{descriptionCount.value=String(description.value.length)});
machineSelect.addEventListener('change',async()=>{
  const machine=machines.find(item=>item.id===machineSelect.value);
  if(machine)machineState.textContent=`${machine.gpuModel||'Machine'} · ${humanMachineState(machine)}`;
  await loadGpus(machineSelect.value);
});
gpuSelect.addEventListener('change',updateSubmitReady);
form.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!form.reportValidity())return;
  if(!machineSelect.value){show('Choisissez une machine reliée.',true);return}
  if(!gpuSelect.value){show('Choisissez un GPU vérifié et disponible.',true);return}
  submitButton.disabled=true;
  try{
    show('Vérification finale et publication…');
    const listing=await api('/rental/listings',{method:'POST',body:JSON.stringify({
      machineId:machineSelect.value,
      acceleratorId:gpuSelect.value,
      title:value('title'),
      description:value('description'),
      hourlySol:Number(form.elements.hourlySol.value),
    })});
    show(`Annonce publiée pour ${listing.accelerator?.model||'le GPU sélectionné'}.`);
    form.reset();
    descriptionCount.value='0';
    await loadAccount();
  }catch(e){
    const reason=e.data?.details?.blockingReason;
    show(reason?`Publication refusée : ${humanGpuBlock(reason)}.`:`Publication refusée : ${e.message||'erreur inconnue'}.`,true);
    updateSubmitReady();
  }
});
document.querySelector('#resetForm').addEventListener('click',async()=>{
  form.reset();
  descriptionCount.value='0';
  message.textContent='';
  await loadGpus('');
  updateSubmitReady();
});
loadAccount();
