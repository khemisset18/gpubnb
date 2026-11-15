'use strict';

// Discovery only. No booking or streaming authority is granted here.
// The existing Stage 4 private start page rechecks the server again before
// making any booking or starting the signed Windows graphics runtime.
(() => {
  const base = (window.GPUBNB_CONFIG?.apiBase || window.GPUBNB_API_URL || '').replace(/\/$/, '');
  const status = document.querySelector('#gamingPilotStatus');
  const continueLink = document.querySelector('#gamingPilotContinue');
  const params = new URLSearchParams(location.search);
  const machineId = params.get('machine');

  function show(text) {
    if (status) status.textContent = text;
  }

  async function read(path) {
    const response = await fetch(`${base}${path}`, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('not_authorized');
    return response.json();
  }

  async function check() {
    // The private Windows preflight is not an ownership check. Verify the
    // explicit machine against the owner-only management endpoint first.
    if (!/^c[a-z0-9]{20,31}$/.test(machineId || '')) {
      show('Ouvrez cet essai depuis une machine de votre tableau de bord.');
      return;
    }

    try {
      const identity = await read('/auth/me');
      if (typeof identity?.user?.id !== 'string' || !identity.user.id) return;
      const managed = await read(`/machines/${encodeURIComponent(machineId)}/workspaces/manage`);
      if (!Array.isArray(managed?.workspaces)) return;
      const preflight = await read('/qualification/windows-native/preflight');
      if (preflight?.privateNoPaymentMode !== true ||
          preflight?.allowed !== true ||
          preflight?.code !== 'PRIVATE_WINDOWS_TEST_ATTEMPT_ALLOWED') {
        show('Essai Gaming indisponible : le Host privé Windows n’est pas actuellement autorisé.');
        return;
      }

      // Do not include machine IDs, credentials, tokens or booking claims
      // in a navigation URL; the next page performs the real POST gating.
      if (continueLink) continueLink.hidden = false;
      show('PC1 autorise un essai privé Cloud Desktop. Aucun jeu n’est lancé automatiquement.');
    } catch {
      show('Essai Gaming privé non autorisé. Vérifiez votre compte et la machine.');
    }
  }

  void check();
})();
