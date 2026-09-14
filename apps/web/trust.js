'use strict';

const TRUST_API=(window.GPUBNB_API_URL||'').replace(/\/$/,'');

function text(id,value){const node=document.getElementById(id);if(node)node.textContent=value}
function state(id,value){const node=document.getElementById(id);if(node)node.dataset.state=value}

async function jsonFetch(path){
  const response=await fetch(`${TRUST_API}${path}`,{credentials:'include',headers:{accept:'application/json'},cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
  return data;
}

async function loadHealth(){
  try{
    const health=await jsonFetch('/health');
    text('trustApiStatus','Disponible');
    text('trustApiDetail',`Cluster déclaré : ${health.cluster||'inconnu'}`);
    state('trustApiCard','ok');
    if(health.mainnetEnabled===true){
      text('trustNetworkStatus','Mainnet activé');
      text('trustNetworkDetail','Le serveur indique que les paiements réels sont autorisés.');
    }else{
      text('trustNetworkStatus','Devnet / Mainnet verrouillé');
      text('trustNetworkDetail','Le serveur n’autorise pas le Mainnet dans cette configuration.');
    }
  }catch(error){
    text('trustApiStatus','Non vérifiée');
    text('trustApiDetail','Impossible de vérifier actuellement l’état public de l’API.');
    text('trustNetworkStatus','Non vérifié');
    text('trustNetworkDetail','Le réseau de paiement ne peut pas être confirmé sans réponse API.');
    console.error(error);
  }
}

async function loadWindowsRelease(){
  const downloads=window.GPUBNB_HOST_DOWNLOADS;
  if(!downloads?.fetchMetadata){
    text('trustReleaseStatus','Non vérifiée');
    text('trustReleaseDetail','Le module de métadonnées de release est indisponible.');
    return;
  }
  try{
    const metadata=await downloads.fetchMetadata('windows');
    if(!metadata.available){
      text('trustReleaseStatus','Indisponible');
      text('trustReleaseDetail','Aucun installeur Windows qualifié n’est actuellement publié sur le canal public.');
      return;
    }
    text('trustReleaseStatus','Métadonnées disponibles');
    text('trustReleaseDetail','Version, commit et empreinte sont publiés par le canal de release.');
    state('trustReleaseCard','ok');
    text('trustReleaseVersion',metadata.version||'Non publiée');
    text('trustReleaseCommit',metadata.immutableVersion||'Non publié');
    text('trustReleasePublished',metadata.publishedAt?new Date(metadata.publishedAt).toLocaleString('fr-FR'):'Inconnue');
    text('trustReleaseSha',metadata.sha256||'Non publiée');
  }catch(error){
    text('trustReleaseStatus','Non vérifiée');
    text('trustReleaseDetail','Impossible de vérifier actuellement le canal public de release.');
    console.error(error);
  }
}

Promise.allSettled([loadHealth(),loadWindowsRelease()]);
