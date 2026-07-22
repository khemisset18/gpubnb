'use strict';
const API=(window.GPUBNB_CONFIG?.apiBase||'').replace(/\/$/,'');
const form=document.querySelector('#publishForm');
const message=document.querySelector('#formMessage');
const description=form.elements.description;
const descriptionCount=document.querySelector('#descriptionCount');
const machineSelect=form.elements.machineId;
const agentKey=form.elements.agentPublicKey;
let csrfToken=null;
async function api(path,options={}){const r=await fetch(`${API}${path}`,{credentials:'include',headers:{'content-type':'application/json',...(csrfToken&&options.method&&options.method!=='GET'?{'x-csrf-token':csrfToken}:{}),...(options.headers||{})},...options});const data=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(data.error||'Erreur API');e.status=r.status;throw e}return data;}
function show(text,error=false){message.textContent=text;message.className=`form-message ${error?'error':'success'}`}
function value(name){return String(form.elements[name].value||'').trim()}
async function loadAccount(){try{const me=await api('/auth/me');csrfToken=me.csrfToken;document.querySelector('#accountState').textContent=`Connecté : ${me.user.pseudonym}`;const machines=await api('/machines/mine');machineSelect.replaceChildren(new Option('Créer une machine avec la clé agent',''));for(const m of machines){const label=`${m.gpuModel||'GPU non vérifié'} · ${m.connectivity} · ${m.id}`;machineSelect.add(new Option(label,m.id));}}catch(e){if(e.status===401){location.href='/auth.html?next=publish';return}show('Impossible de charger le compte.',true)}}
description.addEventListener('input',()=>{descriptionCount.value=String(description.value.length)});
machineSelect.addEventListener('change',()=>{agentKey.required=!machineSelect.value;agentKey.closest('label').hidden=Boolean(machineSelect.value)});
form.addEventListener('submit',async event=>{event.preventDefault();if(!form.reportValidity())return;try{show('Publication en cours…');let machineId=machineSelect.value;if(!machineId){const created=await api('/machines',{method:'POST',body:JSON.stringify({agentPublicKey:value('agentPublicKey')})});machineId=created.id;}const listing=await api('/listings',{method:'POST',body:JSON.stringify({machineId,title:value('title'),description:value('description'),hourlySol:Number(form.elements.hourlySol.value)})});show(listing.status==='ACTIVE'?'Annonce publiée et visible.':`Annonce créée. Elle deviendra visible dès que l’agent GPU sera en ligne. ID machine : ${machineId}`);form.reset();descriptionCount.value='0';await loadAccount();}catch(e){show(e.message||'Publication impossible',true)}});
document.querySelector('#resetForm').addEventListener('click',()=>{form.reset();descriptionCount.value='0';message.textContent=''});
loadAccount();
