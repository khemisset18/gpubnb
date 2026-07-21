'use strict';
const STORAGE_KEY='gpubnb.demo.listings.v1';
const form=document.querySelector('#publishForm');
const list=document.querySelector('#localListings');
const count=document.querySelector('#localCount');
const message=document.querySelector('#formMessage');
const description=form.elements.description;
const descriptionCount=document.querySelector('#descriptionCount');
function readListings(){try{const parsed=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');return Array.isArray(parsed)?parsed:[]}catch{return []}}
function writeListings(items){localStorage.setItem(STORAGE_KEY,JSON.stringify(items))}
function escapeText(value){return String(value??'')}
function render(){const items=readListings();count.textContent=String(items.length);list.replaceChildren();if(!items.length){const p=document.createElement('p');p.className='panel-empty';p.textContent='Aucune annonce locale enregistrée.';list.append(p);return}for(const item of items){const card=document.createElement('article');card.className='local-listing';const content=document.createElement('div');const title=document.createElement('h3');title.textContent=escapeText(item.title);const meta=document.createElement('p');meta.textContent=`${escapeText(item.gpuModel)} · ${Number(item.vramGb)} GB · ${Number(item.hourlySol).toFixed(4)} SOL/h`;const location=document.createElement('span');location.textContent=`${escapeText(item.location)} · ${escapeText(item.ownerPseudonym)}`;content.append(title,meta,location);const remove=document.createElement('button');remove.type='button';remove.className='delete-listing';remove.setAttribute('aria-label',`Supprimer ${item.title}`);remove.textContent='Supprimer';remove.addEventListener('click',()=>{writeListings(readListings().filter(x=>x.id!==item.id));render();message.textContent='Annonce locale supprimée.';message.className='form-message success'});card.append(content,remove);list.append(card)}}
function value(name){return String(form.elements[name].value||'').trim()}
description.addEventListener('input',()=>{descriptionCount.value=String(description.value.length)});
form.addEventListener('submit',event=>{event.preventDefault();message.textContent='';message.className='form-message';if(!form.reportValidity())return;const listing={id:`local-${Date.now()}-${crypto.randomUUID?.()||Math.random().toString(36).slice(2)}`,title:value('title'),gpuModel:value('gpuModel'),vramGb:Number(form.elements.vramGb.value),hourlySol:Number(form.elements.hourlySol.value),location:value('location'),ownerPseudonym:value('ownerPseudonym'),description:value('description'),createdAt:new Date().toISOString()};const items=readListings();items.unshift(listing);writeListings(items);form.reset();descriptionCount.value='0';message.textContent='Annonce publiée localement. Elle est maintenant visible sur la marketplace.';message.className='form-message success';render()});
document.querySelector('#resetForm').addEventListener('click',()=>{form.reset();descriptionCount.value='0';message.textContent='';message.className='form-message'});render();
