'use strict';

import { WindowsNativeDesktopClient } from './windows-native-desktop.js';

export function nativeDesktopStreamPath(sessionId) {
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > 200 ||
    !/^[A-Za-z0-9_-]+$/u.test(sessionId)
  ) {
    throw new Error('windows_native_session_id_invalid');
  }
  return `/workspace-gateway/${encodeURIComponent(sessionId)}/native-stream`;
}

export function mountWindowsNativeDesktop({
  documentObject = globalThis.document,
  locationObject = globalThis.location,
  clientFactory = (options) => new WindowsNativeDesktopClient(options),
} = {}) {
  if (!documentObject || !locationObject) {
    throw new Error('windows_native_page_environment');
  }
  const canvas = documentObject.querySelector('#nativeDesktopCanvas');
  const status = documentObject.querySelector('#nativeDesktopStatus');
  const closeButton = documentObject.querySelector('#nativeDesktopClose');
  if (!canvas || !status || !closeButton) {
    throw new Error('windows_native_page_contract');
  }

  const sessionId = new URLSearchParams(locationObject.search).get('session');
  const streamPath = nativeDesktopStreamPath(sessionId);
  const setStatus = (value) => {
    status.textContent = value;
  };

  const client = clientFactory({
    canvas,
    onState: (state) => {
      const label = {
        connecting: 'Connexion sécurisée…',
        connected: 'Canal authentifié, attente de la première image…',
        ready: 'Bureau distant actif',
        closed: 'Session vidéo fermée',
      }[state?.state] ?? 'État inconnu';
      setStatus(label);
    },
    onError: () => setStatus('Connexion interrompue — aucune commande supplémentaire n’est envoyée.'),
  });

  const unbind = client.bindDom({ keyboardTarget: documentObject, pointerTarget: canvas });
  const stop = () => {
    try { unbind(); } catch {}
    client.close();
  };
  closeButton.addEventListener('click', stop, { once: true });
  globalThis.addEventListener?.('pagehide', stop, { once: true });

  client.start(streamPath, locationObject.href);
  return { client, stop, streamPath };
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  try {
    mountWindowsNativeDesktop();
  } catch {
    const status = document.querySelector('#nativeDesktopStatus');
    if (status) status.textContent = 'La session bureau n’est pas disponible.';
  }
}
