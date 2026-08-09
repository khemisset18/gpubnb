'use strict';
(() => {
  const API=(window.GPUBNB_API_URL||'').replace(/\/$/,'');
  const escapeHTML=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  async function request(path,options={}){
    const headers={accept:'application/json',...(options.headers||{})};
    if(options.body!==undefined)headers['content-type']='application/json';
    const response=await fetch(`${API}${path}`,{credentials:'include',...options,headers});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(data.error||`HTTP ${response.status}`),{status:response.status,code:data.error});
    return data;
  }
  const reason={
    GATEWAY_NOT_READY:'Connexion sécurisée en préparation',WORKSPACE_NOT_READY:'Workspace encore en préparation',
    HEARTBEAT_STALE:'Machine temporairement indisponible',MACHINE_OFFLINE:'Machine hors ligne',
    MACHINE_BLOCKED:'Machine indisponible pour sécurité',BOOKING_NOT_ACTIVE:'Réservation non active',SESSION_EXPIRED:'Session terminée'
  };
  async function render(){
    const root=document.querySelector('[data-workspace-bookings]');
    if(!root)return;
    try{
      const dashboard=await request('/dashboard');
      const bookings=dashboard.tenant?.bookings||[];
      if(!bookings.length){root.innerHTML='<div class="empty-state"><p class="muted">Aucun workspace lié à une réservation.</p></div>';return;}
      const rows=await Promise.all(bookings.map(async booking=>{
        try{return {booking,workspace:await request(`/bookings/${encodeURIComponent(booking.id)}/workspace`)}}catch(error){return {booking,error}}
      }));
      root.innerHTML=rows.map(({booking,workspace,error})=>{
        if(error?.status===404){
          const canPrepare=['FUNDED','STARTING','ACTIVE'].includes(booking.status);
          return `<article class="list-row"><div><strong>${escapeHTML(booking.listing?.title||'Réservation GPU')}</strong><div class="muted">Aucun workspace préparé pour cette réservation.</div></div><div class="actions">${canPrepare?`<button class="button button-primary" type="button" data-prepare-developer="${escapeHTML(booking.id)}">Préparer Developer</button>`:''}<span class="badge warn">Non préparé</span></div></article>`;
        }
        if(error)return `<article class="list-row"><div><strong>${escapeHTML(booking.listing?.title||'Réservation GPU')}</strong><div class="muted">État du workspace indisponible.</div></div><span class="badge warn">Erreur</span></article>`;
        const preparing=workspace.status==='PREPARING';
        const statusText=workspace.canOpen?'Prêt à ouvrir':preparing?`Préparation ${Number(workspace.preparation?.progress||0)} %`:(reason[workspace.blockedReason]||workspace.status);
        return `<article class="list-row"><div><strong>${escapeHTML(workspace.workspace?.name||'Workspace')}</strong><div class="muted">${escapeHTML(workspace.gpu?.model||'GPU distant')} · ${escapeHTML(statusText)}</div>${workspace.preparation?.step?`<div class="muted">Étape : ${escapeHTML(workspace.preparation.step)}</div>`:''}</div><div class="actions">${workspace.canOpen?`<button class="button button-primary" type="button" data-open-workspace="${escapeHTML(booking.id)}">Ouvrir mon espace</button>`:''}<span class="badge ${workspace.canOpen?'ok':'warn'}">${escapeHTML(workspace.status)}</span></div></article>`;
      }).join('');
      root.querySelectorAll('[data-prepare-developer]').forEach(button=>button.addEventListener('click',async()=>{
        button.disabled=true;button.textContent='Préparation…';
        try{await request(`/bookings/${encodeURIComponent(button.dataset.prepareDeveloper)}/workspace/developer`,{method:'POST',body:'{}'});await render();}
        catch(error){button.disabled=false;button.textContent='Préparer Developer';alert(error.code==='developer_workspace_not_enabled'?'Le propriétaire doit d’abord activer Developer Workspace sur cette machine.':(error.message||'Préparation impossible.'));}
      }));
      root.querySelectorAll('[data-open-workspace]').forEach(button=>button.addEventListener('click',async()=>{
        button.disabled=true;button.textContent='Ouverture…';
        try{
          const result=await request(`/bookings/${encodeURIComponent(button.dataset.openWorkspace)}/workspace/access`,{method:'POST',body:'{}'});
          location.href=`${API}${result.openPath}`;
        }catch(error){button.disabled=false;button.textContent='Ouvrir mon espace';alert(error.code==='workspace_gateway_not_ready'?'La connexion sécurisée au workspace n’est pas encore prête.':(error.message||'Ouverture impossible.'));}
      }));
    }catch(error){root.innerHTML=`<div class="empty-state"><p class="muted">${escapeHTML(error.message||'Impossible de charger les workspaces.')}</p></div>`;}
  }
  window.addEventListener('DOMContentLoaded',()=>{void render();setInterval(()=>void render(),10000)});
})();
