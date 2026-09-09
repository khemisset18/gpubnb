'use strict';

const MD_API=(window.GPUBNB_API_URL||'').replace(/\/$/,'');
const mdEscape=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const mdDate=value=>value?new Date(value).toLocaleString('fr-FR'):'—';

const CHECK_LABELS={agent:'Agent',gpu:'GPU',gpuUuid:'UUID GPU',driver:'Pilote GPU',docker:'Docker',nvidiaRuntime:'Runtime NVIDIA',runtimeCleanup:'Nettoyage runtime',temperature:'Température GPU',cuda:'CUDA',ram:'RAM',allocation:'Allocation GPU'};
const CHECK_BADGE={PASS:'ok',FAIL:'danger',WARNING:'warn',UNKNOWN:'warn',NOT_CHECKED:'warn'};
const CHECK_ICON={PASS:'🟢',FAIL:'🔴',WARNING:'🟠',UNKNOWN:'⚪',NOT_CHECKED:'⚪'};
const SEVERITY_ICON={CRITICAL:'🔴',WARNING:'🟠',INFO:'🟢'};
const STATE_LABELS={
  NOT_LINKED:'Host non relié',WAITING_FOR_FIRST_HEARTBEAT:'Premier signal en attente',OFFLINE:'Host hors ligne',AGENT_OUTDATED:'Agent obsolète — mise à jour requise',GPU_NOT_DETECTED:'GPU non détecté',DRIVER_MISSING:'Pilote GPU manquant',DOCKER_UNAVAILABLE:'Docker indisponible',NVIDIA_RUNTIME_UNAVAILABLE:'Runtime NVIDIA indisponible',DIAGNOSTIC_REQUIRED:'Diagnostic GPU requis',DIAGNOSTIC_RUNNING:'Diagnostic en cours',DIAGNOSTIC_FAILED:'Diagnostic en échec',VERIFICATION_REQUIRED:'Vérification Host requise',READY_TO_PUBLISH:'Prête à publier',LISTING_ACTIVE:'Marketplace actif',RESERVED:'Réservée',SESSION_STARTING:'Session en démarrage',SESSION_ACTIVE:'Session active',CLEANUP_REQUIRED:'Nettoyage à vérifier',QUARANTINED:'Quarantaine',
};
const STATE_BADGE={READY_TO_PUBLISH:'ok',LISTING_ACTIVE:'ok',SESSION_ACTIVE:'ok',RESERVED:'ok',SESSION_STARTING:'ok',QUARANTINED:'danger',OFFLINE:'warn',DIAGNOSTIC_RUNNING:'warn'};

let pollTimer=null;
let currentData=null;

async function mdRequest(path,options={}){
  const headers={accept:'application/json',...(options.headers||{})};
  if(options.body!==undefined&&!('content-type' in headers))headers['content-type']='application/json';
  const response=await fetch(`${MD_API}${path}`,{credentials:'include',...options,headers});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data.error||`HTTP ${response.status}`);error.status=response.status;error.data=data;throw error}
  return data;
}

function renderChecklist(checks){
  if(!Array.isArray(checks)||!checks.length)return '<p class="muted">Aucun diagnostic n’a encore été exécuté sur cette machine.</p>';
  return `<div class="table-list">${checks.map(c=>`<div class="list-row"><div><strong>${CHECK_ICON[c.status]||''} ${mdEscape(CHECK_LABELS[c.name]||c.name)}</strong><div class="muted">${mdEscape(c.details||'')}${c.value?` · ${mdEscape(String(c.value))}`:''}</div><div class="muted">Mesuré ${mdDate(c.measuredAt)} · source : ${mdEscape(c.source||'—')}</div></div><span class="badge ${CHECK_BADGE[c.status]||'warn'}">${mdEscape(c.status)}</span></div>`).join('')}</div>`;
}

function renderCompatibility(list){
  if(!Array.isArray(list)||!list.length)return '<p class="muted">Compatibilité non calculée.</p>';
  return `<div class="table-list">${list.map(w=>`<div class="list-row"><div><strong>${mdEscape(w.name)}</strong><div class="muted">${mdEscape((w.missing||[]).join(', ')||'Toutes les conditions sont satisfaites.')}</div></div><span class="badge ${w.compatible?'ok':'danger'}">${w.compatible?'🟢 COMPATIBLE':'🔴 INCOMPATIBLE'}</span></div>`).join('')}</div>`;
}

function renderHistory(events){
  if(!Array.isArray(events)||!events.length)return '<p class="muted">Aucun historique de quarantaine pour cette machine.</p>';
  const statusLabel={ENTERED:'🔴 Quarantaine',DIAGNOSTIC:'🔎 Diagnostic',CLEARED:'🟢 Quarantaine levée',REENTERED:'🔴 Quarantaine maintenue'};
  return `<div class="table-list">${events.map(e=>`<div class="list-row"><div><strong>${mdEscape(statusLabel[e.status]||e.status)}${e.forced?' · forcé par un administrateur':''}</strong><div class="muted">${mdEscape(e.reasonTitle||e.reasonCode)} — ${mdEscape(e.reason)}</div><div class="muted">${mdDate(e.createdAt)} · source : ${mdEscape(e.source)}</div></div></div>`).join('')}</div>`;
}

function activeQuarantineCause(data){
  if(!Array.isArray(data.history))return null;
  return data.history.find(event=>(event.status==='ENTERED'||event.status==='REENTERED')&&!event.resolvedAt)||null;
}

function renderBody(data){
  const state=data.state||{};
  const stateBadge=STATE_BADGE[state.state]||'warn';
  const quarantine=data.quarantine||{};
  const running=data.runningDiagnostic;
  const last=data.lastDiagnosticRun;
  const cause=activeQuarantineCause(data);

  const quarantinePanel=quarantine.active?`<article class="panel" style="margin-bottom:14px"><div class="section-heading"><div><h2>${SEVERITY_ICON[quarantine.severity]||'🔴'} EN QUARANTAINE</h2><p class="muted">${mdEscape(quarantine.title)}</p></div><span class="badge danger">${mdEscape(quarantine.reasonCode)}</span></div>${cause?`<div class="form-message error" style="margin-bottom:10px"><strong>Cause détectée :</strong> ${mdEscape(cause.reason)}</div>`:''}<p>${mdEscape(quarantine.description)}</p><div class="muted"><strong>Impact :</strong> ${mdEscape(quarantine.impact)}</div><div class="muted"><strong>Depuis :</strong> ${mdDate(quarantine.since)}</div><div class="muted"><strong>Preuve nécessaire :</strong> ${mdEscape(quarantine.evidenceRequired||'—')}</div><div style="margin-top:10px"><strong>Action recommandée :</strong> ${mdEscape(quarantine.recommendedAction||'Utilisez « Résoudre automatiquement ».')}</div></article>`:'';

  const runningPanel=running?`<article class="panel" style="margin-bottom:14px"><span class="badge warn">Résolution en cours</span><p class="muted">Diagnostic lancé ${mdDate(running.startedAt)} — l’agent effectue les preuves réelles. Cette page se rafraîchit automatiquement.</p></article>`:'';

  return `
${quarantinePanel}
${runningPanel}
<article class="panel" style="margin-bottom:14px">
  <div class="section-heading"><div><h2>État machine</h2></div><span class="badge ${stateBadge}">${mdEscape(STATE_LABELS[state.state]||state.state||'Inconnu')}</span></div>
  <div class="muted">Dernier heartbeat : ${mdDate(data.lastHeartbeatAt)} ${data.heartbeatFresh?'(frais)':'(ancien)'}</div>
  <div class="muted">Dernier diagnostic : ${mdDate(data.lastDiagnosticAt)}</div>
  <div class="muted">Lifecycle : ${mdEscape(data.lifecycleStatus)}</div>
</article>
<article class="panel" style="margin-bottom:14px">
  <h2>Problèmes détectés</h2>
  ${renderChecklist(last?last.checks:null)}
  ${last?`<p class="muted" style="margin-top:8px">Dernier diagnostic : ${mdEscape(last.status)} · déclenché par ${mdEscape(last.triggeredBy)} · ${mdDate(last.startedAt)}${last.error?` · erreur : ${mdEscape(last.error)}`:''}</p>`:''}
</article>
<article class="panel" style="margin-bottom:14px">
  <h2>Compatibilité par type de Workspace</h2>
  ${renderCompatibility(data.compatibility)}
</article>
<article class="panel">
  <h2>Historique de la machine</h2>
  ${renderHistory(data.history)}
</article>`;
}

async function loadAndRender(machineId){
  const root=document.querySelector('[data-md-body]');
  const data=await mdRequest(`/rental/machines/${encodeURIComponent(machineId)}/diagnostics`);
  currentData=data;
  document.querySelector('[data-md-title]').textContent=`Machine ${machineId}`;
  root.innerHTML=renderBody(data);

  const rerunButton=document.querySelector('[data-md-rerun]');
  const resolveButton=document.querySelector('[data-md-repair]');
  const quarantined=data.quarantine?.active===true;
  rerunButton.hidden=quarantined;
  resolveButton.hidden=!quarantined;
  if(quarantined){
    resolveButton.textContent=data.runningDiagnostic?'Résolution en cours…':'Résoudre automatiquement';
    resolveButton.disabled=Boolean(data.runningDiagnostic);
    resolveButton.title=data.repair?.description||'GPUbnb lance automatiquement les contrôles nécessaires et lève la quarantaine uniquement si les preuves sont bonnes.';
  }else{
    rerunButton.disabled=false;
    resolveButton.disabled=false;
  }

  if(pollTimer){clearInterval(pollTimer);pollTimer=null}
  if(data.runningDiagnostic){
    pollTimer=setInterval(async()=>{
      try{await loadAndRender(machineId)}catch{/* keep polling despite a transient error */}
    },4000);
  }
  return data;
}

async function startAutomaticResolution(machineId){
  const data=currentData||await loadAndRender(machineId);
  if(data.repair){
    try{
      await mdRequest(`/rental/machines/${encodeURIComponent(machineId)}/diagnostics/repair`,{method:'POST'});
    }catch(error){
      // A concurrent heartbeat/repair may have already removed the bookkeeping
      // issue between rendering and clicking. In that one race the correct next
      // step is still the real diagnostic, not an error page.
      if(error.data?.error!=='no_safe_repair_available')throw error;
    }
  }
  await mdRequest(`/rental/machines/${encodeURIComponent(machineId)}/diagnostics/rerun`,{method:'POST'});
  return loadAndRender(machineId);
}

document.addEventListener('DOMContentLoaded',()=>{
  const machineId=new URLSearchParams(location.search).get('machineId');
  if(!machineId){document.querySelector('[data-md-body]').innerHTML='<div class="panel"><p class="muted">Aucune machine sélectionnée. Retournez à « Mes machines ».</p></div>';return}

  loadAndRender(machineId).catch(error=>{
    document.querySelector('[data-md-body]').innerHTML=`<div class="panel"><p class="muted">Impossible de charger les diagnostics : ${mdEscape(error.message||'erreur inconnue')}</p></div>`;
  });

  document.querySelector('[data-md-rerun]').addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;const original=button.textContent;button.textContent='Lancement…';
    try{
      await mdRequest(`/rental/machines/${encodeURIComponent(machineId)}/diagnostics/rerun`,{method:'POST'});
      await loadAndRender(machineId);
    }catch(error){
      document.querySelector('[data-md-body]').insertAdjacentHTML('afterbegin',`<div class="form-message error">Impossible de lancer le diagnostic : ${mdEscape(error.data?.error||error.message)}</div>`);
    }finally{button.disabled=false;button.textContent=original}
  });

  document.querySelector('[data-md-repair]').addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;const original=button.textContent;button.textContent='Résolution…';
    try{
      await startAutomaticResolution(machineId);
      document.querySelector('[data-md-body]').insertAdjacentHTML('afterbegin','<div class="form-message success">Résolution lancée. GPUbnb effectue les vérifications et lèvera automatiquement la quarantaine seulement si tout est sûr.</div>');
    }catch(error){
      document.querySelector('[data-md-body]').insertAdjacentHTML('afterbegin',`<div class="form-message error">Résolution impossible : ${mdEscape(error.data?.error||error.message)}</div>`);
    }finally{button.disabled=false;button.textContent=original}
  });
});
