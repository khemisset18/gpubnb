'use strict';
(() => {
  const API=(window.GPUBNB_API_URL||'').replace(/\/$/,'');
  const currentBookingStatuses=new Set(['CREATED','AWAITING_DEPOSIT','FUNDED','STARTING','ACTIVE']);
  const preparableBookingStatuses=new Set(['FUNDED','STARTING','ACTIVE']);
  const escapeHTML=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
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
    DOWNLOADING:'Téléchargement de l’image GPU Proof',
    PREPARING:'Préparation du workload GPU',
    RUNNING:'GPU Proof en cours',
    UPLOADING_RESULTS:'Envoi et vérification des résultats',
    COMPLETED:'GPU Proof terminé',
    FAILED:'GPU Proof échoué',
    CANCEL_REQUESTED:'Arrêt demandé',
    CANCELLED:'GPU Proof annulé',
    TIMED_OUT:'GPU Proof expiré',
    REJECTED:'GPU Proof refusé',
    QUARANTINED:'Machine mise en quarantaine'
  };
  const terminalOk=new Set(['COMPLETED']);
  const terminalFailure=new Set(['FAILED','CANCELLED','TIMED_OUT','REJECTED','QUARANTINED']);

  function rowHTML(booking,job,history=false){
    const title=escapeHTML(booking.listing?.title||'Réservation GPU');
    if(!job){
      if(booking.status==='AWAITING_DEPOSIT'){
        return `<article class="list-row"><div><strong>${title}</strong><div class="muted">Financement bêta en cours. Compute démarrera uniquement après le passage à FUNDED.</div></div><span class="badge warn">AWAITING_DEPOSIT</span></article>`;
      }
      const canPrepare=!history&&preparableBookingStatuses.has(booking.status);
      return `<article class="list-row"><div><strong>${title}</strong><div class="muted">Aucun GPU_PROOF Compute n’est encore associé à cette réservation.</div></div><div class="actions">${canPrepare?`<button class="button button-primary" type="button" data-prepare-compute="${escapeHTML(booking.id)}">Préparer Compute</button>`:''}<span class="badge ${history?'':'warn'}">${escapeHTML(booking.status)}</span></div></article>`;
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
        ?`<section class="workspace-latest-failure" role="alert"><h3>Dernier GPU Proof interrompu</h3><p class="muted">La réservation reste visible avec le code d’erreur réel. Aucun basculement automatique vers Developer n’est effectué.</p>${rowHTML(latestFailure.booking,latestFailure.job,true)}</section>`
        :'';
      root.innerHTML=`${active.length?active.map(row=>rowHTML(row.booking,row.job)).join(''):'<div class="empty-state"><p class="muted">Aucune réservation active.</p></div>'}${failureNotice}${history.length?`<details class="workspace-history"><summary>Historique des réservations (${history.length})</summary>${history.map(row=>rowHTML(row.booking,row.job,true)).join('')}</details>`:''}`;

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
    }catch(error){root.innerHTML=`<div class="empty-state"><p class="muted">${escapeHTML(error.message||'Impossible de charger les réservations GPU.')}</p></div>`;}
  }
  window.addEventListener('DOMContentLoaded',()=>{void render();setInterval(()=>void render(),10000)});
})();
