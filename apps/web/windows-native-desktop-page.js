'use strict';

function safeNativeDesktopErrorCode(error) {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Za-z0-9_:-]{1,120}$/u.test(message) ? message : 'windows_native_client_failed';
}

import { WindowsNativeDesktopClient } from './windows-native-desktop.js?v=20261003-input-blob-1';

const NATIVE_RECONNECT_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 5000]);
const NATIVE_RECONNECT_WINDOW_MS = 10 * 60 * 1000;

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
  windowObject = globalThis,
  clientFactory = (options) => new WindowsNativeDesktopClient(options),
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeoutFn = (timer) => globalThis.clearTimeout(timer),
  now = () => Date.now(),
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

  let currentClient = null;
  let unbindCurrent = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnectStartedAt = null;
  let pageHidden = false;
  let stopped = false;

  const cancelReconnect = () => {
    if (reconnectTimer === null) return;
    try { clearTimeoutFn(reconnectTimer); } catch {}
    reconnectTimer = null;
  };

  const releaseCurrent = () => {
    const client = currentClient;
    const unbind = unbindCurrent;
    currentClient = null;
    unbindCurrent = null;
    try { unbind?.(); } catch {}
    try { client?.close(); } catch {}
  };

  const markRecovered = () => {
    cancelReconnect();
    reconnectAttempt = 0;
    reconnectStartedAt = null;
  };

  let connect = () => {};

  const scheduleReconnect = () => {
    if (stopped || pageHidden || currentClient || reconnectTimer !== null) return;

    const timestamp = now();
    if (reconnectStartedAt === null) reconnectStartedAt = timestamp;
    if (timestamp - reconnectStartedAt >= NATIVE_RECONNECT_WINDOW_MS) {
      stopped = true;
      setStatus('Session vidéo fermée');
      return;
    }

    const delay = NATIVE_RECONNECT_DELAYS_MS[
      Math.min(reconnectAttempt, NATIVE_RECONNECT_DELAYS_MS.length - 1)
    ];
    reconnectAttempt += 1;
    setStatus('Connexion interrompue, reconnexion…');
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      if (!stopped && !pageHidden && !currentClient) connect();
    }, delay);
  };

  connect = () => {
    if (stopped || pageHidden || currentClient) return;

    let client = null;
    client = clientFactory({
      canvas,
      onState: (state) => {
        if (client !== currentClient) return;

        if (state?.state === 'closed') {
          const unbind = unbindCurrent;
          currentClient = null;
          unbindCurrent = null;
          try { unbind?.(); } catch {}

          if (stopped) {
            setStatus('Session vidéo fermée');
            return;
          }
          if (pageHidden) return;
          scheduleReconnect();
          return;
        }

        if (state?.state === 'ready') markRecovered();

        const label = {
          connecting: reconnectAttempt > 0 ? 'Reconnexion sécurisée…' : 'Connexion sécurisée…',
          connected: 'Canal authentifié, attente de la première image…',
          ready: 'Bureau distant actif',
        }[state?.state] ?? 'État inconnu';
        setStatus(label);
      },
      onError: (error) => {
        if (client !== currentClient) return;
        setStatus(`Connexion interrompue — ${safeNativeDesktopErrorCode(error)}`);
      },
    });

    currentClient = client;
    try {
      unbindCurrent = client.bindDom({
        keyboardTarget: documentObject,
        pointerTarget: canvas,
      });
      client.start(streamPath, locationObject.href);
    } catch (error) {
      releaseCurrent();
      throw error;
    }
  };

  const onPageHide = () => {
    pageHidden = true;
    cancelReconnect();
    releaseCurrent();
  };

  const onPageShow = () => {
    if (stopped) return;
    pageHidden = false;
    connect();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelReconnect();
    releaseCurrent();
    windowObject.removeEventListener?.('pagehide', onPageHide);
    windowObject.removeEventListener?.('pageshow', onPageShow);
    setStatus('Session vidéo fermée');
  };

  closeButton.addEventListener('click', stop, { once: true });
  windowObject.addEventListener?.('pagehide', onPageHide);
  windowObject.addEventListener?.('pageshow', onPageShow);

  connect();

  return {
    get client() {
      return currentClient;
    },
    stop,
    streamPath,
  };
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  try {
    mountWindowsNativeDesktop();
  } catch {
    const status = document.querySelector('#nativeDesktopStatus');
    if (status) status.textContent = 'La session bureau n’est pas disponible.';
  }
}
