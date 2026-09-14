'use strict';

const API=(window.GPUBNB_API_URL||'').replace(/\/$/,'');
const listings=document.querySelector('#listings');
const status=document.querySelector('#apiStatus');
const networkWarning=document.querySelector('#networkWarning');
const accountButton=document.querySelector('#accountButton');
const refreshButton=document.querySelector('#refresh');
const filterBar=document.querySelector('.filter-bar');
let loadingMarketplace=false;
let marketplaceItems=[];
let activeFilter='all';

function el(tag,text,className){
  const node=document.createElement(tag);
  if(text!==undefined)node.textContent=text;
  if(className)node.className=className;
  return node;
}

async function jsonFetch(url,options={}){
  const headers={accept:'application/json',...(options.headers||{})};
  if(options.body!==undefined&&!('content-type' in headers)&&!('Content-Type' in headers))headers['content-type']='application/json';
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12_000);
  try{
    const response=await fetch(`${API}${url}`,{
      credentials:'include',
      ...options,
      headers,
      signal:options.signal||controller.signal,
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
    return data;
  }finally{
    clearTimeout(timeout);
  }
}

function renderCard(item){
  const card=el('article',undefined,'card');
  const busy=item.availability?.state&&item.availability.state!=='AVAILABLE';
  const badge=el('span',busy?`● ${item.availability.label}`:'● GPU vérifié','eyebrow');
  const title=el('h3',item.title);
  const desc=el('p',item.description);
  const meta=el('div',undefined,'meta');
  const gpu=`${item.gpu.vendor?`${item.gpu.vendor} `:''}${item.gpu.model} · ${item.gpu.vramMiB} MiB`;
  meta.append(el('span',gpu),el('span',item.owner.pseudonym));
  const hourlySol=Number(item.hourlyLamports)/1e9;
  const price=el('div',`${hourlySol.toFixed(4)} SOL/h`,'price');
  let choose;
  if(busy){
    const availableAt=item.availability.availableAt?new Date(item.availability.availableAt).toLocaleString('fr-FR'):'';
    choose=el('button',availableAt?`${item.availability.label} jusqu’au ${availableAt}`:item.availability.label,'button button-secondary');
    choose.disabled=true;
  }else{
    choose=el('a','Choisir ce GPU et mon espace','button button-primary');
    choose.href=`choose-workspace.html?listing=${encodeURIComponent(item.id)}`;
  }
  card.append(badge,title,desc,meta,price,choose);
  return card;
}

function filteredMarketplace(){
  if(activeFilter==='high-vram')return marketplaceItems.filter(item=>Number(item.gpu?.vramMiB)>=24*1024);
  if(activeFilter==='available')return marketplaceItems.filter(item=>!item.availability?.state||item.availability.state==='AVAILABLE');
  return marketplaceItems;
}

function renderMarketplace(){
  if(!listings)return;
  const items=filteredMarketplace();
  listings.replaceChildren();
  if(!items.length){
    const message=marketplaceItems.length
      ? 'Aucun GPU ne correspond à ce filtre pour le moment.'
      : 'Aucun GPU vérifié et connecté pour le moment.';
    listings.append(el('article',message,'empty'));
    return;
  }
  const fragment=document.createDocumentFragment();
  for(const item of items)fragment.append(renderCard(item));
  listings.append(fragment);
}

function selectFilter(next){
  if(!['all','high-vram','available'].includes(next))return;
  activeFilter=next;
  for(const button of filterBar?.querySelectorAll('[data-filter]')||[]){
    const selected=button.dataset.filter===activeFilter;
    button.classList.toggle('active',selected);
    button.setAttribute('aria-pressed',String(selected));
  }
  renderMarketplace();
}

async function loadMarketplace(){
  if(!listings||loadingMarketplace)return;
  loadingMarketplace=true;
  listings.setAttribute('aria-busy','true');
  if(refreshButton)refreshButton.disabled=true;
  listings.replaceChildren(el('article','Chargement…','empty'));

  try{
    const [healthResult,listingResult]=await Promise.allSettled([
      jsonFetch('/health'),
      jsonFetch('/rental/listings'),
    ]);

    if(healthResult.status==='fulfilled'){
      const health=healthResult.value;
      if(status)status.textContent=`API active · ${health.cluster||'cluster inconnu'}`;
      if(networkWarning)networkWarning.textContent=health.mainnetEnabled?'Mainnet activé — paiements réels.':'Mode test : Mainnet verrouillé.';
    }else{
      console.error(healthResult.reason);
      if(status)status.textContent='État API non vérifié';
      if(networkWarning)networkWarning.textContent='La marketplace reste vérifiée séparément.';
    }

    if(listingResult.status==='rejected'){
      console.error(listingResult.reason);
      if(status&&healthResult.status!=='fulfilled')status.textContent='API indisponible';
      listings.replaceChildren(el('article','Marketplace momentanément indisponible. Réessayez dans un instant.','empty'));
      return;
    }

    marketplaceItems=Array.isArray(listingResult.value)?listingResult.value:[];
    renderMarketplace();
  }finally{
    listings.setAttribute('aria-busy','false');
    loadingMarketplace=false;
    if(refreshButton)refreshButton.disabled=false;
  }
}

async function loadAccount(){
  if(!accountButton)return;
  try{
    const me=await jsonFetch('/auth/me');
    accountButton.textContent=me.user.pseudonym;
    accountButton.href=me.user.needsOnboarding?'onboarding.html':'dashboard.html';
  }catch{
    // Anonymous visitors are expected; keep the default sign-in CTA.
  }
}

filterBar?.addEventListener('click',event=>{
  const button=event.target.closest('[data-filter]');
  if(button)selectFilter(button.dataset.filter);
});
refreshButton?.addEventListener('click',()=>void loadMarketplace());
void loadMarketplace();
void loadAccount();
