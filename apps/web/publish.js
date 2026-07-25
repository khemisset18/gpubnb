'use strict';
const API=(window.GPUBNB_CONFIG?.apiBase||'').replace(/\/$/,'');
const form=document.querySelector('#publishForm');
const message=document.querySelector('#formMessage');
const description=form.elements.description;
const descriptionCount=document.querySelector('#descriptionCount');
const machineSelect=form.elements.machineId;
const submitButton=document.querySelector('#publishSubmit');
const machineState=document.querySelector('#machineState');
async function api(path,options={}){const headers={accept:'application/json',...(options.headers||{})};if(options.body!==undefined&&!('content-type' in headers)&&!('Content-Type' in headers))headers['content-type']='application/json';const r=await fetch(`${API}${path}`,{credentials:'include',...options,headers});const data=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(data.error||`HTTP ${r.status}`);e.status=r.status;throw e}return data;}
function show(text,error=false){message.textContent=text;message.className=`form-message ${error?'error':'success'}`}
function value(name){return String(form.elements[name].value||'').trim()}
function setPublishReady(ready){submitButton.disabled=!ready;machineSelect.disabled=!ready}
async function loadAccount(){setPublishReady(false);try{const me=await api('/auth/me');document.querySelector('#accountState').textContent=`Connecté : ${me.user.pseudonym}`;if(!me.user.canHost){machineState.textContent='Activez le rôle propriétaire avant de publier.';show('Le rôle propriétaire est requis.',true);return}const machines=await api('/machines/mine');machineSelect.replaceChildren();if(!machines.length){machineSelect.add(new Option('Aucune machine reliée',''));machineState.textContent='Aucune machine reliée. Installez GPUbnb Host puis créez un code de liaison.';show('Reliez d’abord une machine avec GPUbnb Host.',true);return}machineSelect.add(new Option('Choisir une machine',''));for(const m of machines){const status=m.connectivity==='ONLINE'?'En ligne':'Hors ligne';const verified=m.verifiedAt?'Vérifiée':'En attente de vérification';const label=`${m.gpuModel||'GPU en détection'} · ${status} · ${verified}`;machineSelect.add(new Option(label,m.id));}machineState.textContent=`${machines.length} machine${machines.length>1?'s':''} reliée${machines.length>1?'s':''}.`;setPublishReady(true);}catch(e){if(e.status===401){location.href='/auth.html?next=publish';return}machineSelect.replaceChildren(new Option('Machines indisponibles',''));machineState.textContent='Impossible de charger les machines.';show('Impossible de charger le compte ou les machines.',true)}}
description.addEventListener('input',()=>{descriptionCount.value=String(description.value.length)});
form.addEventListener('submit',async event=>{event.preventDefault();if(!form.reportValidity())return;if(!machineSelect.value){show('Choisissez une machine reliée.',true);return}submitButton.disabled=true;try{show('Publication en cours…');const listing=await api('/listings',{method:'POST',body:JSON.stringify({machineId:machineSelect.value,title:value('title'),description:value('description'),hourlySol:Number(form.elements.hourlySol.value)})});show(listing.status==='ACTIVE'?'Annonce publiée et visible.':'Annonce créée. Elle deviendra visible dès que le GPU sera vérifié et en ligne.');form.reset();descriptionCount.value='0';await loadAccount();}catch(e){show(e.message||'Publication impossible',true);submitButton.disabled=false}});
document.querySelector('#resetForm').addEventListener('click',()=>{form.reset();descriptionCount.value='0';message.textContent=''});
loadAccount();
