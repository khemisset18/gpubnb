'use strict';

(() => {
  const API=(window.GPUBNB_API_URL||window.location.origin||'').replace(/\/$/,'');
  const button=document.querySelector('#stage3-start');
  const status=document.querySelector('#stage3-status');

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

  async function run(){
    button.disabled=true;
    try{
      setStatus('Vérification du compte PC2…');
      await request('/auth/me');

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
      setStatus(error.message||'Échec du test Stage 3.',true);
      button.disabled=false;
    }
  }

  button?.addEventListener('click',()=>{void run();});
})();
