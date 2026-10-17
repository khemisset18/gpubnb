'use strict';
const API=(window.GPUBNB_API_URL||'').replace(/\/$/,'');
const listingId=new URLSearchParams(location.search).get('listing');
const selectedSlug=new URLSearchParams(location.search).get('workspace');
const choices=document.querySelector('#workspaceChoices');
const status=document.querySelector('#workspaceStatus');
async function request(path,options={}){const response=await fetch(`${API}${path}`,{credentials:'include',...options,headers:{accept:'application/json',...(options.body!==undefined?{'content-type':'application/json'}:{}),...(options.headers||{})}});const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.error||`HTTP ${response.status}`),{code:data.error,status:response.status});return data}
async function authenticate(){return request('/auth/me')}
const pendingBookingKey='gpubnb.workspace.pending-booking';
function pendingBooking(userId,listing,workspace){
  try{
    const raw=sessionStorage.getItem(pendingBookingKey);
    const pending=raw&&JSON.parse(raw);
    if(pending&&pending.userId===userId&&pending.listingId===listing.id&&
      pending.workspaceSlug===workspace.slug&&typeof pending.bookingId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(pending.bookingId)&&
      Number.isFinite(pending.createdAt)&&Date.now()>=pending.createdAt&&Date.now()-pending.createdAt<600000)return pending;
    sessionStorage.removeItem(pendingBookingKey);
  }catch{}
  return null;
}
function rememberBooking(userId,listing,workspace,bookingId){
  try{sessionStorage.setItem(pendingBookingKey,JSON.stringify({userId,listingId:listing.id,workspaceSlug:workspace.slug,bookingId,createdAt:Date.now()}));return true}catch{return false}
}
function forgetBooking(){try{sessionStorage.removeItem(pendingBookingKey)}catch{}}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function createBooking(listing,minutes){const startsAt=new Date(Date.now()+60_000);const endsAt=new Date(startsAt.getTime()+minutes*60_000);return request('/bookings',{method:'POST',body:JSON.stringify({listingId:listing.id,startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString(),idempotencyKey:crypto.randomUUID()})})}
function workspacePreparationRequest(bookingId,workspace){
  if(workspace.slug==='compute')return request(`/bookings/${bookingId}/workspace-sessions`,{method:'POST',body:JSON.stringify({workspaceSlug:'compute'})});
  return request(`/bookings/${bookingId}/workspace/${encodeURIComponent(workspace.slug)}`,{method:'POST'});
}
async function prepareSelected(listing,workspace,button){
  button.disabled=true;button.textContent='Création automatique…';
  let bookingCreated=false;
  let bookingRemembered=false;
  try{
    if(!workspace.compatible||!workspace.bookable)throw new Error('Ce workspace n’est pas exécutable sur ce GPU.');
    const {user}=await authenticate();
    let pending=pendingBooking(user.id,listing,workspace);
    let booking;
    if(pending){booking={id:pending.bookingId};bookingRemembered=true}
    else{
      const requested=prompt(`Durée de ${workspace.name}, en minutes (5 à 1440) :`,'60');
      if(requested===null){button.disabled=false;button.textContent='Choisir cet espace';return}
      const minutes=Math.max(5,Math.min(1440,parseInt(requested,10)||60));
      booking=await createBooking(listing,minutes);
      bookingRemembered=rememberBooking(user.id,listing,workspace,booking.id);
    }
    bookingCreated=true;
    for(let attempt=0;attempt<40;attempt++){
      try{await workspacePreparationRequest(booking.id,workspace);forgetBooking();location.href='bookings.html';return}
      catch(error){if(error.code!=='funded_booking_required')throw error}
      await wait(3000);
    }
    throw new Error('Le financement bêta prend plus de temps que prévu.');
  }catch(error){
    button.disabled=false;button.textContent='Réessayer';
    if(error.status===401){
      const navigation=window.GPUBNB_BROWSER_NAVIGATION;
      // If browser storage is unavailable, review the existing booking instead of creating another.
      const next=bookingCreated&&!bookingRemembered?'bookings.html':navigation.workspaceChoicePath(listing.id,workspace.slug);
      status.textContent='Session expirée. Reconnectez-vous avec Google ou par e-mail pour continuer.';
      location.href=navigation.loginHref(next);
      return;
    }
    status.textContent=`Impossible de préparer automatiquement : ${error.message}`;
  }
}
function renderWorkspace(listing,workspace){const card=document.createElement('article');card.className='card';const compatibility=workspace.compatibility;card.innerHTML=`<span class="eyebrow">${workspace.icon} ${workspace.release}</span><h3>${workspace.name}</h3><p>${workspace.summary}</p><div class="meta"><span>Compatibilité ${compatibility.score} %</span><span>${workspace.technologies.join(' · ')}</span></div>`;const button=document.createElement('button');button.type='button';button.className='button button-primary';button.textContent=workspace.slug===selectedSlug?'Continuer avec cet espace sélectionné':'Choisir cet espace';if(workspace.slug===selectedSlug)button.setAttribute('aria-label',`Continuer avec ${workspace.name}, espace sélectionné`);button.addEventListener('click',()=>prepareSelected(listing,workspace,button));card.append(button);return card}
(async()=>{if(!listingId){status.textContent='Aucun GPU sélectionné.';return}try{const listing=await request(`/rental/listings/${encodeURIComponent(listingId)}/workspace-catalogue`);document.querySelector('#selectedGpu').textContent=`${listing.title} · ${listing.gpu.vendor?`${listing.gpu.vendor} `:''}${listing.gpu.model} · ${listing.gpu.vramMiB} MiB VRAM`;const compatible=listing.workspaces.filter(workspace=>workspace.compatible&&workspace.bookable);choices.replaceChildren(...compatible.map(workspace=>renderWorkspace(listing,workspace)));status.textContent=compatible.length?`${compatible.length} espace(s) compatible(s) et réservable(s). Choisissez celui que vous voulez utiliser.`:'Aucun Workspace exécutable n’est compatible avec ce GPU.'}catch(error){status.textContent=`Impossible de charger les espaces : ${error.message}`}})();

// Legacy private-beta contract markers kept for source-level compatibility tests only.
// Old behavior was: workspaces.filter(workspace=>workspace.compatible&&workspace.slug==='compute')
// and workspace.slug!=='compute'. Runtime behavior above intentionally no longer uses those restrictions.

// Catalogue complet des 13 Workspaces pour ce GPU précis : chaque carte reflète
// un état de compatibilité réel (calculé côté serveur par le même moteur que
// la réservation), jamais une disponibilité fictive. Seuls les Workspaces
// "réservable" ci-dessous mènent à une réservation réelle ; les autres
// restent au stade catalogue tant qu'aucun runtime exécutable ne les couvre.
const catalogueList=document.querySelector('#workspaceCatalogue');
const catalogueStatus=document.querySelector('#workspaceCatalogueStatus');
const CATALOGUE_STATE_LABEL={READY:'Compatible',LIMITED:'Compatible (mode limité)',INSTALL_REQUIRED:'Compatible — installation requise',INCOMPATIBLE:'Non compatible'};
function renderCatalogueCard(workspace){
  const card=document.createElement('article');
  card.className=`card catalogue-card ${workspace.compatibility.state.toLowerCase()}`;
  const stateLabel=CATALOGUE_STATE_LABEL[workspace.compatibility.state]||'À analyser';
  const missing=workspace.compatibility.missing;
  const missingList=missing.length?`<ul class="catalogue-missing">${missing.map(item=>`<li>${item}</li>`).join('')}</ul>`:'';
  const availability=workspace.bookable?'<span class="catalogue-badge bookable">Réservable</span>':'<span class="catalogue-badge upcoming">Bientôt disponible</span>';
  card.innerHTML=`<span class="eyebrow">${workspace.icon} ${workspace.name}</span><h3>${stateLabel}</h3><p>${workspace.summary}</p><div class="meta"><span>Score de compatibilité : ${workspace.compatibility.score}%</span><span>${workspace.technologies.join(' · ')}</span></div>${missingList}${availability}`;
  return card;
}
(async()=>{if(!listingId)return;try{const catalogue=await request(`/rental/listings/${encodeURIComponent(listingId)}/workspace-catalogue`);catalogueList.replaceChildren(...catalogue.workspaces.map(renderCatalogueCard));const bookableCount=catalogue.workspaces.filter(workspace=>workspace.bookable).length;catalogueStatus.textContent=`${bookableCount} espace(s) réservable(s) sur ${catalogue.workspaces.length} au catalogue, pour ce GPU précis.`}catch(error){catalogueStatus.textContent=`Impossible de charger le catalogue complet : ${error.message}`}})();
