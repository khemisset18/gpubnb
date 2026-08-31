'use strict';
import { DeveloperPhase, deriveDeveloperPhase, preparationLabel, resolveWorkspaceOpenUrl } from './workspace-developer-flow.js';

(() => {
  const API=(window.GPUBNB_API_URL||'').replace(/\/$/,'');
  const GATEWAY=(window.GPUBNB_GATEWAY_URL||API||'').replace(/\/$/,'');
  const currentBookingStatuses=new Set(['CREATED','AWAITING_DEPOSIT','FUNDED','STARTING','ACTIVE']);
  const preparableBookingStatuses=new Set(['FUNDED','STARTING','ACTIVE']);
  const escapeHTML=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  // Per-booking in-flight guard: prevents a double click (or an overlapping
  // 10s poll re-render) from firing a second create/open request while one
  // is still pending. The server's own (bookingId, machineWorkspaceId)
  // uniqueness already makes creation idempotent, but avoiding the redundant
  // request client-side keeps the UI honest about what's actually happening.
  const developerActionInFlight=new Set();
  const developerErrors=new Map();
  // workspaceDetail cache, refreshed each render() pass for bookings whose
  // GPU_PROOF just completed. Avoids re-declaring types across renders.
  const developerDetailByBooking=new Map();
  // Data Workspace reuses the exact same phase machinery as Developer
  // (deriveDeveloperPhase/preparationLabel are generic despite the name - see
  // workspace-developer-flow.js) with its own tracking maps, since it's a
  // separate real workspace/session, not an alias for the Developer one.
  const dataActionInFlight=new Set();
  const dataErrors=new Map();
  const dataDetailByBooking=new Map();
  const aiActionInFlight=new Set();
  const aiErrors=new Map();
  const aiDetailByBooking=new Map();
  const videoActionInFlight=new Set();
  const videoErrors=new Map();
  const videoDetailByBooking=new Map();
  const audioActionInFlight=new Set();
  const audioErrors=new Map();
  const audioDetailByBooking=new Map();
  const apiActionInFlight=new Set();
  const apiErrors=new Map();
  const apiDetailByBooking=new Map();

  async function request(path,options={}){
    const headers={accept:'application/json',...(options.headers||{})};
    if(options.body!==undefined)headers['content-type']='application/json';
    const response=await fetch(`${API}${path}`,{credentials:'include',...options,headers});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(data.error||`HTTP ${response.status}`),{status:response.status,code:data.error});
    return data;
  }
  const jobLabel={
    QUEUED:'En attente de prise en charge par l’agent hôte',
    ASSIGNED:'Pris en charge par l’agent hôte',
    DOWNLOADING:'Téléchargement de l’image de vérification',
    PREPARING:'Préparation du workload GPU',
    RUNNING:'Vérification GPU en cours',
    UPLOADING_RESULTS:'Envoi et vérification des résultats',
    COMPLETED:'Vérification GPU terminée',
    FAILED:'Vérification GPU échouée',
    CANCEL_REQUESTED:'Arrêt demandé',
    CANCELLED:'Vérification GPU annulée',
    TIMED_OUT:'Vérification GPU expirée',
    REJECTED:'Vérification GPU refusée',
    QUARANTINED:'Machine mise en quarantaine'
  };
  const terminalOk=new Set(['COMPLETED']);
  const terminalFailure=new Set(['FAILED','CANCELLED','TIMED_OUT','REJECTED','QUARANTINED']);

  function developerBlockHTML(booking,job,detail,errorMessage){
    const phase=deriveDeveloperPhase({bookingStatus:booking.status,gpuProofJob:job,workspaceDetail:detail});
    if(phase===DeveloperPhase.HIDDEN)return '';
    const title=escapeHTML(booking.listing?.title||'Réservation GPU');
    const errorHTML=errorMessage?`<div class="muted">${escapeHTML(errorMessage)}</div>`:'';
    let action='';let badge=`<span class="badge">${escapeHTML(detail?.status||'')}</span>`;
    if(phase===DeveloperPhase.CREATE){
      action=`<button class="button button-primary" type="button" data-create-developer="${escapeHTML(booking.id)}">Créer mon espace de travail</button>`;
      badge='';
    }else if(phase===DeveloperPhase.PREPARING){
      // Never surface the raw session status here: it can legitimately read
      // "READY" (the container/runtime finished) while the gateway tunnel is
      // still not registered - i.e. the workspace is not actually openable
      // yet. preparationLabel() reflects the fine-grained phase instead,
      // which distinguishes that case (GATEWAY_NOT_READY) from real READY.
      action=`<span class="muted">${escapeHTML(preparationLabel(detail))}</span>`;
      badge='';
    }else if(phase===DeveloperPhase.OPEN){
      action=`<button class="button button-primary" type="button" data-open-developer="${escapeHTML(booking.id)}">Ouvrir mon espace</button>`;
      badge='<span class="badge ok">PRÊT</span>';
    }else if(phase===DeveloperPhase.RETRY){
      action=`<button class="button" type="button" data-retry-developer="${escapeHTML(booking.id)}">Réessayer</button>`;
      badge=`<span class="badge warn">${escapeHTML(detail?.preparation?.errorCode||detail?.status||'ÉCHEC')}</span>`;
    }else if(phase===DeveloperPhase.ENDED){
      badge=`<span class="badge">${escapeHTML(detail?.status||'TERMINÉ')}</span>`;
    }
    return `<article class="list-row" data-developer-row="${escapeHTML(booking.id)}"><div><strong>Espace de travail · ${title}</strong>${errorHTML}</div><div class="actions">${action}${badge}</div></article>`;
  }

  function dataBlockHTML(booking,job,detail,errorMessage){
    const phase=deriveDeveloperPhase({bookingStatus:booking.status,gpuProofJob:job,workspaceDetail:detail});
    if(phase===DeveloperPhase.HIDDEN)return '';
    const title=escapeHTML(booking.listing?.title||'Réservation GPU');
    const errorHTML=errorMessage?`<div class="muted">${escapeHTML(errorMessage)}</div>`:'';
    let action='';let badge=`<span class="badge">${escapeHTML(detail?.status||'')}</span>`;
    if(phase===DeveloperPhase.CREATE){
      action=`<button class="button button-primary" type="button" data-create-data="${escapeHTML(booking.id)}">Créer mon espace Data</button>`;
      badge='';
    }else if(phase===DeveloperPhase.PREPARING){
      action=`<span class="muted">${escapeHTML(preparationLabel(detail))}</span>`;
      badge='';
    }else if(phase===DeveloperPhase.OPEN){
      action=`<button class="button button-primary" type="button" data-open-data="${escapeHTML(booking.id)}">Ouvrir JupyterLab</button>`;
      badge='<span class="badge ok">PRÊT</span>';
    }else if(phase===DeveloperPhase.RETRY){
      action=`<button class="button" type="button" data-retry-data="${escapeHTML(booking.id)}">Réessayer</button>`;
      badge=`<span class="badge warn">${escapeHTML(detail?.preparation?.errorCode||detail?.status||'ÉCHEC')}</span>`;
    }else if(phase===DeveloperPhase.ENDED){
      badge=`<span class="badge">${escapeHTML(detail?.status||'TERMINÉ')}</span>`;
    }
    return `<article class="list-row" data-data-row="${escapeHTML(booking.id)}"><div><strong>Espace Data · ${title}</strong>${errorHTML}</div><div class="actions">${action}${badge}</div></article>`;
  }

  function aiBlockHTML(booking,job,detail,errorMessage){
    const phase=deriveDeveloperPhase({bookingStatus:booking.status,gpuProofJob:job,workspaceDetail:detail});
    if(phase===DeveloperPhase.HIDDEN)return '';
    const title=escapeHTML(booking.listing?.title||'Réservation GPU');
    const errorHTML=errorMessage?`<div class="muted">${escapeHTML(errorMessage)}</div>`:'';
    let action='';let badge=`<span class="badge">${escapeHTML(detail?.status||'')}</span>`;
    if(phase===DeveloperPhase.CREATE){
      action=`<button class="button button-primary" type="button" data-create-ai="${escapeHTML(booking.id)}">Créer mon espace IA</button>`;
      badge='';
    }else if(phase===DeveloperPhase.PREPARING){
      action=`<span class="muted">${escapeHTML(preparationLabel(detail))}</span>`;
      badge='';
    }else if(phase===DeveloperPhase.OPEN){
      action=`<button class="button button-primary" type="button" data-open-ai="${escapeHTML(booking.id)}">Ouvrir JupyterLab (GPU)</button>`;
      badge='<span class="badge ok">PRÊT</span>';
    }else if(phase===DeveloperPhase.RETRY){
      action=`<button class="button" type="button" data-retry-ai="${escapeHTML(booking.id)}">Réessayer</button>`;
      badge=`<span class="badge warn">${escapeHTML(detail?.preparation?.errorCode||detail?.status||'ÉCHEC')}</span>`;
    }else if(phase===DeveloperPhase.ENDED){
      badge=`<span class="badge">${escapeHTML(detail?.status||'TERMINÉ')}</span>`;
    }
    return `<article class="list-row" data-ai-row="${escapeHTML(booking.id)}"><div><strong>Espace IA · ${title}</strong>${errorHTML}</div><div class="actions">${action}${badge}</div></article>`;
  }

  function videoBlockHTML(booking,job,detail,errorMessage){
    const phase=deriveDeveloperPhase({bookingStatus:booking.status,gpuProofJob:job,workspaceDetail:detail});
    if(phase===DeveloperPhase.HIDDEN)return '';
    const title=escapeHTML(booking.listing?.title||'Réservation GPU');
    const errorHTML=errorMessage?`<div class="muted">${escapeHTML(errorMessage)}</div>`:'';
    let action='';let badge=`<span class="badge">${escapeHTML(detail?.status||'')}</span>`;
    if(phase===DeveloperPhase.CREATE){
      action=`<button class="button button-primary" type="button" data-create-video="${escapeHTML(booking.id)}">Créer mon espace Vidéo</button>`;
      badge='';
    }else if(phase===DeveloperPhase.PREPARING){
      action=`<span class="muted">${escapeHTML(preparationLabel(detail))}</span>`;
      badge='';
    }else if(phase===DeveloperPhase.OPEN){
      action=`<button class="button button-primary" type="button" data-open-video="${escapeHTML(booking.id)}">Ouvrir JupyterLab (FFmpeg/NVENC)</button>`;
      badge='<span class="badge ok">PRÊT</span>';
    }else if(phase===DeveloperPhase.RETRY){
      action=`<button class="button" type="button" data-retry-video="${escapeHTML(booking.id)}">Réessayer</button>`;
      badge=`<span class="badge warn">${escapeHTML(detail?.preparation?.errorCode||detail?.status||'ÉCHEC')}</span>`;
    }else if(phase===DeveloperPhase.ENDED){
      badge=`<span class="badge">${escapeHTML(detail?.status||'TERMINÉ')}</span>`;
    }
    return `<article class="list-row" data-video-row="${escapeHTML(booking.id)}"><div><strong>Espace Vidéo · ${title}</strong>${errorHTML}</div><div class="actions">${action}${badge}</div></article>`;
  }

  function audioBlockHTML(booking,job,detail,errorMessage){
    const phase=deriveDeveloperPhase({bookingStatus:booking.status,gpuProofJob:job,workspaceDetail:detail});
    if(phase===DeveloperPhase.HIDDEN)return '';
    const title=escapeHTML(booking.listing?.title||'Réservation GPU');
    const errorHTML=errorMessage?`<div class="muted">${escapeHTML(errorMessage)}</div>`:'';
    let action='';let badge=`<span class="badge">${escapeHTML(detail?.status||'')}</span>`;
    if(phase===DeveloperPhase.CREATE){
      action=`<button class="button button-primary" type="button" data-create-audio="${escapeHTML(booking.id)}">Créer mon espace Audio</button>`;
      badge='';
    }else if(phase===DeveloperPhase.PREPARING){
      action=`<span class="muted">${escapeHTML(preparationLabel(detail))}</span>`;
      badge='';
    }else if(phase===DeveloperPhase.OPEN){
      action=`<button class="button button-primary" type="button" data-open-audio="${escapeHTML(booking.id)}">Ouvrir JupyterLab (FFmpeg audio)</button>`;
      badge='<span class="badge ok">PRÊT</span>';
    }else if(phase===DeveloperPhase.RETRY){
      action=`<button class="button" type="button" data-retry-audio="${escapeHTML(booking.id)}">Réessayer</button>`;
      badge=`<span class="badge warn">${escapeHTML(detail?.preparation?.errorCode||detail?.status||'ÉCHEC')}</span>`;
    }else if(phase===DeveloperPhase.ENDED){
      badge=`<span class="badge">${escapeHTML(detail?.status||'TERMINÉ')}</span>`;
    }
    return `<article class="list-row" data-audio-row="${escapeHTML(booking.id)}"><div><strong>Espace Audio · ${title}</strong>${errorHTML}</div><div class="actions">${action}${badge}</div></article>`;
  }

  function apiBlockHTML(booking,job,detail,errorMessage){
    const phase=deriveDeveloperPhase({bookingStatus:booking.status,gpuProofJob:job,workspaceDetail:detail});
    if(phase===DeveloperPhase.HIDDEN)return '';
    const title=escapeHTML(booking.listing?.title||'Réservation GPU');
    const errorHTML=errorMessage?`<div class="muted">${escapeHTML(errorMessage)}</div>`:'';
    let action='';let badge=`<span class="badge">${escapeHTML(detail?.status||'')}</span>`;
    if(phase===DeveloperPhase.CREATE){
      action=`<button class="button button-primary" type="button" data-create-api="${escapeHTML(booking.id)}">Créer mon espace API</button>`;
      badge='';
    }else if(phase===DeveloperPhase.PREPARING){
      action=`<span class="muted">${escapeHTML(preparationLabel(detail))}</span>`;
      badge='';
    }else if(phase===DeveloperPhase.OPEN){
      // No notebook/lab GUI on the other end (see workspace-manifests.ts) - this
      // opens the real jupyter_server REST API's own root page, which is what a
      // renter gets before switching to calling the API from their own script.
      action=`<button class="button button-primary" type="button" data-open-api="${escapeHTML(booking.id)}">Voir la console API (REST/WebSocket)</button>`;
      badge='<span class="badge ok">PRÊT</span>';
    }else if(phase===DeveloperPhase.RETRY){
      action=`<button class="button" type="button" data-retry-api="${escapeHTML(booking.id)}">Réessayer</button>`;
      badge=`<span class="badge warn">${escapeHTML(detail?.preparation?.errorCode||detail?.status||'ÉCHEC')}</span>`;
    }else if(phase===DeveloperPhase.ENDED){
      badge=`<span class="badge">${escapeHTML(detail?.status||'TERMINÉ')}</span>`;
    }
    return `<article class="list-row" data-api-row="${escapeHTML(booking.id)}"><div><strong>Espace API · ${title}</strong>${errorHTML}</div><div class="actions">${action}${badge}</div></article>`;
  }

  function rowHTML(booking,job,history=false){
    const title=escapeHTML(booking.listing?.title||'Réservation GPU');
    if(!job){
      if(booking.status==='AWAITING_DEPOSIT'){
        return `<article class="list-row"><div><strong>${title}</strong><div class="muted">Financement en cours. Compute démarrera uniquement après le passage à FUNDED.</div></div><span class="badge warn">AWAITING_DEPOSIT</span></article>`;
      }
      const canPrepare=!history&&preparableBookingStatuses.has(booking.status);
      return `<article class="list-row"><div><strong>${title}</strong><div class="muted">Aucune vérification Compute n’est encore associée à cette réservation.</div></div><div class="actions">${canPrepare?`<button class="button button-primary" type="button" data-prepare-compute="${escapeHTML(booking.id)}">Préparer Compute</button>`:''}<span class="badge ${history?'':'warn'}">${escapeHTML(booking.status)}</span></div></article>`;
    }
    const label=jobLabel[job.status]||job.status;
    const errorText=job.errorCode?`<div class="muted">Motif : ${escapeHTML(job.errorCode)}</div>`:'';
    const badgeClass=terminalOk.has(job.status)?'ok':terminalFailure.has(job.status)?'warn':'';
    return `<article class="list-row"><div><strong>Compute · ${title}</strong><div class="muted">${escapeHTML(label)}</div>${errorText}</div><div class="actions"><span class="badge ${badgeClass}">${escapeHTML(job.status)}</span></div></article>`;
  }

  async function render(){
    const root=document.querySelector('[data-workspace-bookings]');
    if(!root)return;
    try{
      const dashboard=await request('/dashboard');
      const bookings=dashboard.tenant?.bookings||[];
      const jobs=dashboard.tenant?.jobs||[];
      if(!bookings.length){root.innerHTML='<div class="empty-state"><p class="muted">Aucune réservation GPU.</p></div>';return;}

      // /dashboard returns jobs newest-first. Keep the newest GPU_PROOF for each
      // booking so the bookings page follows the registered Compute flow instead of
      // probing the separate Developer-only renter routes.
      const latestGpuProofByBooking=new Map();
      for(const job of jobs){
        if(job.type==='GPU_PROOF'&&job.bookingId&&!latestGpuProofByBooking.has(job.bookingId)){
          latestGpuProofByBooking.set(job.bookingId,job);
        }
      }

      const rows=bookings.map(booking=>({booking,job:latestGpuProofByBooking.get(booking.id)||null}));
      const active=rows.filter(row=>currentBookingStatuses.has(row.booking.status));
      const history=rows.filter(row=>!currentBookingStatuses.has(row.booking.status));
      const latestFailure=history.find(row=>row.job&&terminalFailure.has(row.job.status));
      const failureNotice=latestFailure
        ?`<section class="workspace-latest-failure" role="alert"><h3>Dernière vérification interrompue</h3><p class="muted">La réservation reste visible avec le code d’erreur réel. Aucun basculement automatique vers Developer n’est effectué.</p>${rowHTML(latestFailure.booking,latestFailure.job,true)}</section>`
        :'';

      // Only bookings whose GPU_PROOF just completed are eligible for a Developer
      // workspace — fetch their current status (if any) before rendering so the
      // button reflects real server state on first paint, not an optimistic guess.
      // A booking with an in-flight create/open action keeps its cached detail
      // untouched this pass, so a slow poll tick can't clobber a pending click.
      const eligible=active.filter(row=>row.job&&row.job.status==='COMPLETED'&&preparableBookingStatuses.has(row.booking.status));
      await Promise.all(eligible.filter(row=>!developerActionInFlight.has(row.booking.id)).map(async row=>{
        try{
          const detail=await request(`/bookings/${encodeURIComponent(row.booking.id)}/workspace`);
          developerDetailByBooking.set(row.booking.id,detail);
        }catch(error){
          if(error.status===404){developerDetailByBooking.set(row.booking.id,null);}
          // A transient error (network blip) keeps the last known detail instead
          // of flashing back to "Créer mon espace" and risking a duplicate create.
        }
      }));

      const developerHTML=eligible.map(row=>developerBlockHTML(
        row.booking,row.job,developerDetailByBooking.get(row.booking.id)||null,developerErrors.get(row.booking.id),
      )).join('');

      await Promise.all(eligible.filter(row=>!dataActionInFlight.has(row.booking.id)).map(async row=>{
        try{
          const detail=await request(`/bookings/${encodeURIComponent(row.booking.id)}/workspace/data/status`);
          dataDetailByBooking.set(row.booking.id,detail);
        }catch(error){
          if(error.status===404){dataDetailByBooking.set(row.booking.id,null);}
        }
      }));

      const dataHTML=eligible.map(row=>dataBlockHTML(
        row.booking,row.job,dataDetailByBooking.get(row.booking.id)||null,dataErrors.get(row.booking.id),
      )).join('');

      await Promise.all(eligible.filter(row=>!aiActionInFlight.has(row.booking.id)).map(async row=>{
        try{
          const detail=await request(`/bookings/${encodeURIComponent(row.booking.id)}/workspace/ai/status`);
          aiDetailByBooking.set(row.booking.id,detail);
        }catch(error){
          if(error.status===404){aiDetailByBooking.set(row.booking.id,null);}
        }
      }));

      const aiHTML=eligible.map(row=>aiBlockHTML(
        row.booking,row.job,aiDetailByBooking.get(row.booking.id)||null,aiErrors.get(row.booking.id),
      )).join('');

      await Promise.all(eligible.filter(row=>!videoActionInFlight.has(row.booking.id)).map(async row=>{
        try{
          const detail=await request(`/bookings/${encodeURIComponent(row.booking.id)}/workspace/video/status`);
          videoDetailByBooking.set(row.booking.id,detail);
        }catch(error){
          if(error.status===404){videoDetailByBooking.set(row.booking.id,null);}
        }
      }));

      const videoHTML=eligible.map(row=>videoBlockHTML(
        row.booking,row.job,videoDetailByBooking.get(row.booking.id)||null,videoErrors.get(row.booking.id),
      )).join('');

      await Promise.all(eligible.filter(row=>!audioActionInFlight.has(row.booking.id)).map(async row=>{
        try{
          const detail=await request(`/bookings/${encodeURIComponent(row.booking.id)}/workspace/audio/status`);
          audioDetailByBooking.set(row.booking.id,detail);
        }catch(error){
          if(error.status===404){audioDetailByBooking.set(row.booking.id,null);}
        }
      }));

      const audioHTML=eligible.map(row=>audioBlockHTML(
        row.booking,row.job,audioDetailByBooking.get(row.booking.id)||null,audioErrors.get(row.booking.id),
      )).join('');

      await Promise.all(eligible.filter(row=>!apiActionInFlight.has(row.booking.id)).map(async row=>{
        try{
          const detail=await request(`/bookings/${encodeURIComponent(row.booking.id)}/workspace/api/status`);
          apiDetailByBooking.set(row.booking.id,detail);
        }catch(error){
          if(error.status===404){apiDetailByBooking.set(row.booking.id,null);}
        }
      }));

      const apiHTML=eligible.map(row=>apiBlockHTML(
        row.booking,row.job,apiDetailByBooking.get(row.booking.id)||null,apiErrors.get(row.booking.id),
      )).join('');

      root.innerHTML=`${active.length?active.map(row=>rowHTML(row.booking,row.job)).join(''):'<div class="empty-state"><p class="muted">Aucune réservation active.</p></div>'}${developerHTML}${dataHTML}${aiHTML}${videoHTML}${audioHTML}${apiHTML}${failureNotice}${history.length?`<details class="workspace-history"><summary>Historique des réservations (${history.length})</summary>${history.map(row=>rowHTML(row.booking,row.job,true)).join('')}</details>`:''}`;

      root.querySelectorAll('[data-prepare-compute]').forEach(button=>button.addEventListener('click',async()=>{
        button.disabled=true;button.textContent='Préparation Compute…';
        try{
          await request(`/bookings/${encodeURIComponent(button.dataset.prepareCompute)}/workspace-sessions`,{
            method:'POST',
            body:JSON.stringify({workspaceSlug:'compute'})
          });
          await render();
        }catch(error){
          button.disabled=false;button.textContent='Préparer Compute';
          alert(error.code==='funded_booking_required'?'Le financement bêta n’est pas encore terminé.':(error.message||'Préparation Compute impossible.'));
        }
      }));

      async function runDeveloperAction(bookingId,button,busyText,run){
        if(developerActionInFlight.has(bookingId))return;
        developerActionInFlight.add(bookingId);
        button.disabled=true;const originalText=button.textContent;button.textContent=busyText;
        developerErrors.delete(bookingId);
        try{
          await run();
          developerActionInFlight.delete(bookingId);
          await render();
        }catch(error){
          developerActionInFlight.delete(bookingId);
          developerErrors.set(bookingId,error.message||'Action impossible.');
          button.disabled=false;button.textContent=originalText;
          await render();
        }
      }

      root.querySelectorAll('[data-create-developer]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.createDeveloper;
        runDeveloperAction(bookingId,button,'Création…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/developer`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-retry-developer]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.retryDeveloper;
        runDeveloperAction(bookingId,button,'Nouvelle tentative…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/retry`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-open-developer]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.openDeveloper;
        runDeveloperAction(bookingId,button,'Ouverture…',async()=>{
          const access=await request(`/bookings/${encodeURIComponent(bookingId)}/workspace/access`,{method:'POST'});
          const url=resolveWorkspaceOpenUrl(GATEWAY,access);
          window.open(url,'_blank','noopener');
        });
      }));

      async function runDataAction(bookingId,button,busyText,run){
        if(dataActionInFlight.has(bookingId))return;
        dataActionInFlight.add(bookingId);
        button.disabled=true;const originalText=button.textContent;button.textContent=busyText;
        dataErrors.delete(bookingId);
        try{
          await run();
          dataActionInFlight.delete(bookingId);
          await render();
        }catch(error){
          dataActionInFlight.delete(bookingId);
          dataErrors.set(bookingId,error.message||'Action impossible.');
          button.disabled=false;button.textContent=originalText;
          await render();
        }
      }

      root.querySelectorAll('[data-create-data]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.createData;
        runDataAction(bookingId,button,'Création…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/data`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-retry-data]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.retryData;
        runDataAction(bookingId,button,'Nouvelle tentative…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/retry`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-open-data]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.openData;
        runDataAction(bookingId,button,'Ouverture…',async()=>{
          const access=await request(`/bookings/${encodeURIComponent(bookingId)}/workspace/data/access`,{method:'POST'});
          const url=resolveWorkspaceOpenUrl(GATEWAY,access);
          window.open(url,'_blank','noopener');
        });
      }));

      async function runAiAction(bookingId,button,busyText,run){
        if(aiActionInFlight.has(bookingId))return;
        aiActionInFlight.add(bookingId);
        button.disabled=true;const originalText=button.textContent;button.textContent=busyText;
        aiErrors.delete(bookingId);
        try{
          await run();
          aiActionInFlight.delete(bookingId);
          await render();
        }catch(error){
          aiActionInFlight.delete(bookingId);
          aiErrors.set(bookingId,error.message||'Action impossible.');
          button.disabled=false;button.textContent=originalText;
          await render();
        }
      }

      root.querySelectorAll('[data-create-ai]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.createAi;
        runAiAction(bookingId,button,'Création…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/ai`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-retry-ai]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.retryAi;
        runAiAction(bookingId,button,'Nouvelle tentative…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/retry`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-open-ai]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.openAi;
        runAiAction(bookingId,button,'Ouverture…',async()=>{
          const access=await request(`/bookings/${encodeURIComponent(bookingId)}/workspace/ai/access`,{method:'POST'});
          const url=resolveWorkspaceOpenUrl(GATEWAY,access);
          window.open(url,'_blank','noopener');
        });
      }));

      async function runVideoAction(bookingId,button,busyText,run){
        if(videoActionInFlight.has(bookingId))return;
        videoActionInFlight.add(bookingId);
        button.disabled=true;const originalText=button.textContent;button.textContent=busyText;
        videoErrors.delete(bookingId);
        try{
          await run();
          videoActionInFlight.delete(bookingId);
          await render();
        }catch(error){
          videoActionInFlight.delete(bookingId);
          videoErrors.set(bookingId,error.message||'Action impossible.');
          button.disabled=false;button.textContent=originalText;
          await render();
        }
      }

      root.querySelectorAll('[data-create-video]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.createVideo;
        runVideoAction(bookingId,button,'Création…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/video`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-retry-video]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.retryVideo;
        runVideoAction(bookingId,button,'Nouvelle tentative…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/retry`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-open-video]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.openVideo;
        runVideoAction(bookingId,button,'Ouverture…',async()=>{
          const access=await request(`/bookings/${encodeURIComponent(bookingId)}/workspace/video/access`,{method:'POST'});
          const url=resolveWorkspaceOpenUrl(GATEWAY,access);
          window.open(url,'_blank','noopener');
        });
      }));

      async function runAudioAction(bookingId,button,busyText,run){
        if(audioActionInFlight.has(bookingId))return;
        audioActionInFlight.add(bookingId);
        button.disabled=true;const originalText=button.textContent;button.textContent=busyText;
        audioErrors.delete(bookingId);
        try{
          await run();
          audioActionInFlight.delete(bookingId);
          await render();
        }catch(error){
          audioActionInFlight.delete(bookingId);
          audioErrors.set(bookingId,error.message||'Action impossible.');
          button.disabled=false;button.textContent=originalText;
          await render();
        }
      }

      root.querySelectorAll('[data-create-audio]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.createAudio;
        runAudioAction(bookingId,button,'Création…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/audio`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-retry-audio]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.retryAudio;
        runAudioAction(bookingId,button,'Nouvelle tentative…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/retry`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-open-audio]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.openAudio;
        runAudioAction(bookingId,button,'Ouverture…',async()=>{
          const access=await request(`/bookings/${encodeURIComponent(bookingId)}/workspace/audio/access`,{method:'POST'});
          const url=resolveWorkspaceOpenUrl(GATEWAY,access);
          window.open(url,'_blank','noopener');
        });
      }));

      async function runApiAction(bookingId,button,busyText,run){
        if(apiActionInFlight.has(bookingId))return;
        apiActionInFlight.add(bookingId);
        button.disabled=true;const originalText=button.textContent;button.textContent=busyText;
        apiErrors.delete(bookingId);
        try{
          await run();
          apiActionInFlight.delete(bookingId);
          await render();
        }catch(error){
          apiActionInFlight.delete(bookingId);
          apiErrors.set(bookingId,error.message||'Action impossible.');
          button.disabled=false;button.textContent=originalText;
          await render();
        }
      }

      root.querySelectorAll('[data-create-api]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.createApi;
        runApiAction(bookingId,button,'Création…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/api`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-retry-api]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.retryApi;
        runApiAction(bookingId,button,'Nouvelle tentative…',()=>
          request(`/bookings/${encodeURIComponent(bookingId)}/workspace/retry`,{method:'POST'}),
        );
      }));

      root.querySelectorAll('[data-open-api]').forEach(button=>button.addEventListener('click',()=>{
        const bookingId=button.dataset.openApi;
        runApiAction(bookingId,button,'Ouverture…',async()=>{
          const access=await request(`/bookings/${encodeURIComponent(bookingId)}/workspace/api/access`,{method:'POST'});
          const url=resolveWorkspaceOpenUrl(GATEWAY,access);
          window.open(url,'_blank','noopener');
        });
      }));
    }catch(error){root.innerHTML=`<div class="empty-state"><p class="muted">${escapeHTML(error.message||'Impossible de charger les réservations GPU.')}</p></div>`;}
  }
  window.addEventListener('DOMContentLoaded',()=>{void render();setInterval(()=>void render(),10000)});
})();
