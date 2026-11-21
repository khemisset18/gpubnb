'use strict';

(() => {
  const API=(window.GPUBNB_API_URL||window.location.origin||'').replace(/\/$/,'');
  const button=document.querySelector('#stage3-start');
  const checkButton=document.querySelector('#stage3-check');
  const status=document.querySelector('#stage3-status');
  const info=document.querySelector('#stage3-workspace-info');
  const selectors=[...document.querySelectorAll('[data-private-workspace]')];
  const profiles=Object.freeze({
    'cloud-desktop':{
      label:'Cloud Desktop',
      info:"Test vidéo H.264 et clavier/souris en mode privé, si le helper Windows signé et le GPU exact sont prêts. L'audio navigateur est incomplet.",
      canPrivateLaunch:true,
    },
    creator:{
      label:'Creator / Blender',
      info:"Blender Windows : sélection et diagnostic possibles, mais lancement privé bloqué jusqu'à la qualification réelle du helper et du GPU exact.",
      canPrivateLaunch:false,
    },
    cad:{
      label:'CAD / FreeCAD',
      info:"FreeCAD Windows : sélection et diagnostic possibles, mais lancement privé bloqué jusqu'à la qualification réelle du helper et de la capture.",
      canPrivateLaunch:false,
    },
    gaming:{
      label:'Gaming / Steam',
      info:"Gaming Windows : lancement bloqué tant que l'audio navigateur, la manette et la faible latence ne sont pas validés.",
      canPrivateLaunch:false,
    },
  });
  let selectedWorkspace='cloud-desktop';
  let privateReady=false;
  let busy=false;
  
  function showSelection(){
    const profile=profiles[selectedWorkspace];
    selectors.forEach(item=>{
      const selected=item.dataset.privateWorkspace===selectedWorkspace;
      item.setAttribute('aria-pressed',selected?'true':'false');
      item.classList.toggle('button-primary',selected);
      item.disabled=busy;
    });
    if(info)info.textContent=profile.info;
    button.disabled=busy||!privateReady||!profile.canPrivateLaunch;
    button.textContent=profile.canPrivateLaunch
      ? 'Démarrer l\'essai privé Cloud Desktop'
      : profile.label+' : lancement non disponible';
  }
  selectors.forEach(item=>item.addEventListener('click',()=>{
    if(busy||!Object.prototype.hasOwnProperty.call(profiles,item.dataset.privateWorkspace))return;
    selectedWorkspace=item.dataset.privateWorkspace;
    privateReady=false;
    showSelection();
    setStatus('Workspace choisi : '+profiles[selectedWorkspace].label+
      '. Vérification de PC1 nécessaire ; aucune réservation créée.');
  }));

  function setStatus(message,error=false){
    status.textContent=message;
    status.style.color=error?'#ff8b8b':'';
  }

  async function request(path,options={}){
    const headers={accept:'application/json',...(options.headers||{})};
    if(options.body!==undefined)headers['content-type']='application/json';
    const response=await fetch(`${API}${path}`,{
      credentials:'include',
      ...options,
      headers,
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      const error=new Error(data.error||`HTTP ${response.status}`);
      error.status=response.status;
      error.code=data.error||null;
      throw error;
    }
    return data;
  }

  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

  async function bookingStatus(bookingId){
    const dashboard=await request('/dashboard');
    const bookings=dashboard.tenant?.bookings||[];
    return bookings.find(booking=>booking.id===bookingId)||null;
  }

  async function waitForFunding(bookingId){
    const deadline=Date.now()+120000;
    while(Date.now()<deadline){
      const booking=await bookingStatus(bookingId);
      if(!booking)throw new Error('Réservation privée introuvable.');
      setStatus(`Réservation: ${booking.status}…`);
      if(['FUNDED','STARTING','ACTIVE'].includes(booking.status))return booking;
      if(['DEGRADED','COMPLETED','CANCELLED','REFUNDED','SETTLED','DISPUTED'].includes(booking.status)){
        throw new Error(`Réservation arrêtée: ${booking.status}`);
      }
      await sleep(2000);
    }
    throw new Error('Le financement bêta n’a pas été confirmé à temps.');
  }

  async function ensureWorkspace(bookingId){
    setStatus('Création de la session Windows native…');
    try{
      return await request(
        `/bookings/${encodeURIComponent(bookingId)}/workspace/cloud-desktop?qualification=windows-native`,
        {method:'POST'},
      );
    }catch(error){
      if(error.code==='funded_booking_required'){
        await waitForFunding(bookingId);
        return request(
          `/bookings/${encodeURIComponent(bookingId)}/workspace/cloud-desktop?qualification=windows-native`,
          {method:'POST'},
        );
      }
      throw error;
    }
  }

  async function waitForGateway(bookingId){
    const deadline=Date.now()+180000;
    while(Date.now()<deadline){
      const detail=await request(
        `/bookings/${encodeURIComponent(bookingId)}/workspace/cloud-desktop/status`,
      );
      setStatus(
        `Session: ${detail.status} · ${detail.preparation?.step||detail.preparation?.phase||'préparation'}…`,
      );
      if(detail.canOpen)return detail;
      if(['FAILED','CANCELLED','TIMED_OUT','QUARANTINED','COMPLETED'].includes(detail.status)){
        throw new Error(
          detail.preparation?.errorCode
            ? `Session arrêtée: ${detail.preparation.errorCode}`
            : `Session arrêtée: ${detail.status}`,
        );
      }
      await sleep(2000);
    }
    throw new Error('La passerelle Windows native n’est pas devenue prête à temps.');
  }

  async function checkPrivateReadiness(){
    if(busy)return;
    busy=true;
    privateReady=false;
    showSelection();
    checkButton.disabled=true;
    try{
      setStatus('Vérification en lecture seule de la connexion privée et de PC1…');
      await request('/auth/me');
      const preflight=await request('/qualification/windows-native/preflight');
      if(preflight.privateNoPaymentMode!==true){
        throw new Error('Le mode privé sans paiement n\'est pas actif. Aucune réservation créée.');
      }
      if(preflight.allowed!==true){
        const reason={
          PRIVATE_WINDOWS_HOST_NOT_READY:'PC1 ne prouve pas encore sa capacité Windows native.',
          PRIVATE_WINDOWS_HOST_RESERVED:'PC1 est déjà réservé par une autre session.',
        }[preflight.code]||'Préconditions privées manquantes.';
        throw new Error(reason+' Aucune réservation créée.');
      }
      if(!profiles[selectedWorkspace].canPrivateLaunch){
        setStatus('PC1 a passé le précontrôle commun, mais '+profiles[selectedWorkspace].label+
          ' n\'a pas encore de chemin de lancement privé qualifié. Aucune réservation créée.');
      }else{
        privateReady=true;
        setStatus('Précontrôle PC1 favorable. Un clic sur « Démarrer » vérifiera de nouveau les autorisations avant toute session.');
      }
    }catch(error){
      privateReady=false;
      if(error.status===401){
        setStatus('Veuillez vous connecter à votre compte GPUbnb pour effectuer la vérification.',true);
      }else{
        setStatus(error.message||'Vérification privée indisponible.',true);
      }
    }finally{
      busy=false;
      checkButton.disabled=false;
      showSelection();
    }
  }

  async function run(){
    if(busy||selectedWorkspace!=='cloud-desktop'||!privateReady)return;
    busy=true;
    privateReady=false;
    showSelection();
    checkButton.disabled=true;
    try{
      setStatus('Vérification du compte PC2…');
      await request('/auth/me');

      setStatus('Contrôle en lecture seule : mode privé sans paiement et PC1…');
      const preflight=await request('/qualification/windows-native/preflight');
      if(preflight.privateNoPaymentMode!==true){
        throw new Error('Test bloqué : serveur privé sans paiement non activé. Aucune réservation créée.');
      }
      if(preflight.allowed!==true){
        const reason={
          PRIVATE_WINDOWS_HOST_NOT_READY:'PC1 ne confirme pas encore la session Windows native.',
          PRIVATE_WINDOWS_HOST_RESERVED:'PC1 est déjà réservé par une autre session.'
        }[preflight.code]||'Préconditions de qualification manquantes.';
        throw new Error(`Test bloqué : ${reason} Aucune réservation créée.`);
      }

      setStatus('Création de la réservation privée…');
      const booking=await request('/qualification/windows-native/booking',{method:'POST'});

      await waitForFunding(booking.bookingId);
      await ensureWorkspace(booking.bookingId);
      await waitForGateway(booking.bookingId);

      setStatus('Passerelle prête. Ouverture du bureau Windows…');
      const access=await request(
        `/bookings/${encodeURIComponent(booking.bookingId)}/workspace/cloud-desktop/access`,
        {method:'POST'},
      );
      if(!access.openPath)throw new Error('URL d’accès sécurisée absente.');
      window.location.assign(access.openPath);
    }catch(error){
      if(error.status===401){
        setStatus('Session expirée. Reconnectez-vous avec Google ou par e-mail.');
        window.location.assign(window.GPUBNB_BROWSER_NAVIGATION.loginHref('stage3-windows-native.html'));
        return;
      }
      setStatus(error.message||'Échec du test Stage 3.',true);
    }finally{
      busy=false;
      checkButton.disabled=false;
      showSelection();
    }
  }

  showSelection();
  checkButton?.addEventListener('click',()=>{void checkPrivateReadiness();});
  button?.addEventListener('click',()=>{void run();});
})();
