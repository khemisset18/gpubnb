'use strict';

(() => {
  const SELECTOR = [
    '[data-open-developer]',
    '[data-open-data]',
    '[data-open-ai]',
    '[data-open-video]',
    '[data-open-audio]',
    '[data-open-api]',
    '[data-open-mobile]',
    '[data-open-security-lab]',
  ].join(',');

  function accessPath(button, bookingId) {
    if (button.hasAttribute('data-open-developer')) return `/bookings/${encodeURIComponent(bookingId)}/workspace/access`;
    if (button.hasAttribute('data-open-data')) return `/bookings/${encodeURIComponent(bookingId)}/workspace/data/access`;
    if (button.hasAttribute('data-open-ai')) return `/bookings/${encodeURIComponent(bookingId)}/workspace/ai/access`;
    if (button.hasAttribute('data-open-video')) return `/bookings/${encodeURIComponent(bookingId)}/workspace/video/access`;
    if (button.hasAttribute('data-open-audio')) return `/bookings/${encodeURIComponent(bookingId)}/workspace/audio/access`;
    if (button.hasAttribute('data-open-api')) return `/bookings/${encodeURIComponent(bookingId)}/workspace/api/access`;
    if (button.hasAttribute('data-open-mobile')) return `/bookings/${encodeURIComponent(bookingId)}/workspace/mobile/access`;
    if (button.hasAttribute('data-open-security-lab')) return `/bookings/${encodeURIComponent(bookingId)}/workspace/security-lab/access`;
    return null;
  }

  function bookingIdFor(button) {
    return button.dataset.openDeveloper
      || button.dataset.openData
      || button.dataset.openAi
      || button.dataset.openVideo
      || button.dataset.openAudio
      || button.dataset.openApi
      || button.dataset.openMobile
      || button.dataset.openSecurityLab
      || '';
  }

  async function fetchAccess(apiBase, path) {
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (typeof data.openPath !== 'string' || !data.openPath.startsWith('/workspace-gateway/') || data.openPath.includes('..')) {
      throw new Error('workspace_access_response_invalid');
    }
    return data.openPath;
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest(SELECTOR);
    if (!button) return;

    // Capture the click before workspace-bookings.js handles it. Opening a tab
    // after awaiting the access-grant fetch is browser-dependent and can be
    // blocked as a popup. Reserve the tab synchronously while the trusted user
    // activation is still present, then navigate it only after the server has
    // returned a valid, one-time openPath.
    event.preventDefault();
    event.stopPropagation();

    if (button.dataset.workspaceOpening === '1') return;
    const bookingId = bookingIdFor(button);
    const path = accessPath(button, bookingId);
    if (!bookingId || !path) return;

    const reserved = window.open('about:blank', '_blank');
    if (!reserved) {
      window.alert('Le navigateur a bloqué l’ouverture de l’espace. Autorisez les fenêtres pour GPUbnb puis réessayez.');
      return;
    }

    try { reserved.opener = null; } catch {}

    const originalText = button.textContent;
    button.dataset.workspaceOpening = '1';
    button.disabled = true;
    button.textContent = 'Ouverture…';

    const apiBase = String(window.GPUBNB_API_URL || '').replace(/\/$/, '');
    const gatewayBase = String(window.GPUBNB_GATEWAY_URL || apiBase || '').replace(/\/$/, '');

    void (async () => {
      try {
        const openPath = await fetchAccess(apiBase, path);
        const gatewayOrigin = new URL(`${gatewayBase}/`).origin;
        const destination = new URL(openPath, `${gatewayBase}/`);
        if (destination.origin !== gatewayOrigin) throw new Error('workspace_gateway_origin_mismatch');
        reserved.location.replace(destination.href);
      } catch (error) {
        try { reserved.close(); } catch {}
        button.disabled = false;
        button.textContent = originalText;
        const message = error instanceof Error ? error.message : 'Ouverture impossible.';
        window.alert(`Ouverture de l’espace impossible : ${message}`);
      } finally {
        delete button.dataset.workspaceOpening;
      }
    })();
  }, true);
})();
