'use strict';

// Only fixed, source-owned diagnostic codes may reach DevTools or the DOM.
// Arbitrary Error.message strings can be credentials or untrusted codec errors.
const SAFE_NATIVE_DESKTOP_ERROR_CODES = new Set([
  'windows_native_canvas_context',
  'windows_native_canvas_required',
  'windows_native_chunk_factory_required',
  'windows_native_client_callback',
  'windows_native_client_factory',
  'windows_native_client_state',
  'windows_native_decode_queue_full',
  'windows_native_decode_queue_invalid',
  'windows_native_decoder_error_callback',
  'windows_native_decoder_factory',
  'windows_native_decoder_failed',
  'windows_native_decoder_not_ready',
  'windows_native_decoder_output_required',
  'windows_native_decoder_output_unbound',
  'windows_native_decoder_required',
  'windows_native_gateway_base_invalid',
  'windows_native_gateway_cross_origin',
  'windows_native_gateway_downgrade',
  'windows_native_gateway_scheme',
  'windows_native_gateway_socket_error',
  'windows_native_gateway_url_credentials',
  'windows_native_gateway_url_invalid',
  'windows_native_h264_sps_required',
  'windows_native_input_channel_not_ready',
  'windows_native_input_epoch',
  'windows_native_input_flags',
  'windows_native_input_key',
  'windows_native_input_kind',
  'windows_native_input_mouse_absolute',
  'windows_native_input_mouse_button',
  'windows_native_input_mouse_delta',
  'windows_native_input_mouse_relative',
  'windows_native_input_mouse_wheel',
  'windows_native_input_pointer_geometry',
  'windows_native_input_scan_code',
  'windows_native_input_sender',
  'windows_native_input_sequence',
  'windows_native_input_target',
  'windows_native_media_binary_required',
  'windows_native_media_chunk_length',
  'windows_native_media_chunk_range',
  'windows_native_media_clock',
  'windows_native_media_codec',
  'windows_native_media_dimensions',
  'windows_native_media_epoch',
  'windows_native_media_flags',
  'windows_native_media_frame_length',
  'windows_native_media_frame_mismatch',
  'windows_native_media_frame_order',
  'windows_native_media_keyframe_required',
  'windows_native_media_magic',
  'windows_native_media_packet_length',
  'windows_native_media_packet_type',
  'windows_native_media_sequence',
  'windows_native_media_session_required',
  'windows_native_media_timeout',
  'windows_native_media_timeout_invalid',
  'windows_native_media_version',
  'windows_native_page_contract',
  'windows_native_page_environment',
  'windows_native_render_callback',
  'windows_native_session_id_invalid',
  'windows_native_video_frame_dimensions',
  'windows_native_video_frame_required',
  'windows_native_webcodecs_config_unsupported',
  'windows_native_webcodecs_unavailable',
  'windows_native_websocket_required',
]);

export function safeNativeDesktopErrorCode(error) {
  const message = error instanceof Error ? error.message : '';
  return SAFE_NATIVE_DESKTOP_ERROR_CODES.has(message) ? message : 'windows_native_client_failed';
}

import { WindowsNativeDesktopClient } from './windows-native-desktop.js?v=20261126-av-input-1';
import { Stage4VideoContinuity } from './windows-native-continuity.js?v=20261016-1';

const NATIVE_RECONNECT_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 5000]);
const NATIVE_RECONNECT_WINDOW_MS = 10 * 60 * 1000;
// A single decoded frame does not prove the media path is stable.
const NATIVE_STABLE_STREAM_MS = 10 * 1000;

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
  apiFetch = (...args) => globalThis.fetch?.(...args),
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeoutFn = (timer) => globalThis.clearTimeout(timer),
  setIntervalFn = (callback, delay) => globalThis.setInterval(callback, delay),
  clearIntervalFn = (timer) => globalThis.clearInterval(timer),
  now = () => Date.now(),
  proofNow = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  if (!documentObject || !locationObject) {
    throw new Error('windows_native_page_environment');
  }
  const canvas = documentObject.querySelector('#nativeDesktopCanvas');
  const status = documentObject.querySelector('#nativeDesktopStatus');
  const closeButton = documentObject.querySelector('#nativeDesktopClose');
  const stopSessionButton = documentObject.querySelector('#nativeDesktopStopSession');
  const fullscreenButton = documentObject.querySelector('#nativeDesktopFullscreen');
  const pointerLockButton = documentObject.querySelector('#nativeDesktopPointerLock');
  const audioEnableButton = documentObject.querySelector('#nativeDesktopAudioEnable');
  const audioVolume = documentObject.querySelector('#nativeDesktopAudioVolume');
  const proofIndicator = documentObject.querySelector('#nativeDesktopContinuity');
  const gamingWorkspace = documentObject.body?.dataset?.workspaceKind === 'gaming';
  if (!canvas || !status || !closeButton) {
    throw new Error('windows_native_page_contract');
  }

  const sessionId = new URLSearchParams(locationObject.search).get('session');
  const streamPath = nativeDesktopStreamPath(sessionId);
  const apiBase = String(windowObject.GPUBNB_CONFIG?.apiBase || windowObject.GPUBNB_API_URL || '')
    .replace(/\/$/u, '');
  const manageLink = documentObject.querySelector('#nativeDesktopManage');
  if (manageLink) manageLink.href = `session.html?id=${encodeURIComponent(sessionId)}`;
  const setStatus = (value) => {
    status.textContent = value;
  };
  const updateFullscreenButton = () => {
    if (!fullscreenButton) return;
    const active = Boolean(documentObject.fullscreenElement);
    fullscreenButton.textContent = active ? 'Quitter le plein écran' : 'Plein écran';
    fullscreenButton.setAttribute?.('aria-pressed', active ? 'true' : 'false');
  };
  const updatePointerLockButton = () => {
    if (!pointerLockButton) return;
    const active = documentObject.pointerLockElement === canvas;
    pointerLockButton.textContent = active ? 'Libérer la souris' : 'Verrouiller la souris';
    pointerLockButton.setAttribute?.('aria-pressed', active ? 'true' : 'false');
  };
  const requestFullscreen = async () => {
    try {
      if (documentObject.fullscreenElement) {
        await documentObject.exitFullscreen?.();
      } else {
        const target = documentObject.documentElement || canvas;
        if (typeof target.requestFullscreen !== 'function') throw new Error('fullscreen_unavailable');
        await target.requestFullscreen();
      }
    } catch {
      setStatus('Le plein écran est indisponible dans ce navigateur.');
    }
    updateFullscreenButton();
  };
  const togglePointerLock = async () => {
    try {
      if (documentObject.pointerLockElement === canvas) {
        await documentObject.exitPointerLock?.();
      } else {
        if (typeof canvas.requestPointerLock !== 'function') throw new Error('pointer_lock_unavailable');
        canvas.focus?.({ preventScroll: true });
        await canvas.requestPointerLock();
      }
    } catch {
      setStatus('Le verrouillage de la souris est indisponible dans ce navigateur.');
    }
    updatePointerLockButton();
  };
  const exitPresentationModes = () => {
    if (documentObject.pointerLockElement === canvas) {
      try { documentObject.exitPointerLock?.(); } catch {}
    }
    if (documentObject.fullscreenElement) {
      try { Promise.resolve(documentObject.exitFullscreen?.()).catch(() => {}); } catch {}
    }
  };
  fullscreenButton?.addEventListener('click', requestFullscreen);
  pointerLockButton?.addEventListener('click', togglePointerLock);
  const enableAudio = () => { void currentClient?.enableAudio?.(); };
  const changeAudioVolume = () => {
    const volume = Number(audioVolume?.value);
    if (Number.isFinite(volume)) currentClient?.setAudioVolume?.(volume);
  };
  audioEnableButton?.addEventListener('click', enableAudio);
  audioVolume?.addEventListener('input', changeAudioVolume);
  documentObject.addEventListener?.('fullscreenchange', updateFullscreenButton);
  documentObject.addEventListener?.('pointerlockchange', updatePointerLockButton);
  updateFullscreenButton();
  updatePointerLockButton();
  const proof = proofIndicator ? new Stage4VideoContinuity() : null;
  // Backoff recovery is a separate proof, even when no 300s indicator is shown.
  // One decoded image followed by a frozen stream is NOT a stable connection.
  const stableProof = new Stage4VideoContinuity({ minimumMs: NATIVE_STABLE_STREAM_MS });
  const showProof = () => {
    if (!proof || !proofIndicator) return;
    const result = proof.snapshot(proofNow());
    proofIndicator.textContent = result.video300sObserved
      ? 'Vidéo 300 s observée · effet des commandes à confirmer'
      : `Vidéo continue : ${result.continuousSeconds}/300 s`;
  };
  const resetProof = () => {
    proof?.reset();
    showProof();
  };

  let currentClient = null;
  let unbindCurrent = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnectStartedAt = null;
  let pageHidden = false;
  let stopped = false;
  let serverStopConfirmed = false;
  const proofTimer = proof ? setIntervalFn(showProof, 1_000) : null;
  showProof();

  const cancelReconnect = () => {
    if (reconnectTimer === null) return;
    try { clearTimeoutFn(reconnectTimer); } catch {}
    reconnectTimer = null;
  };

  const releaseCurrent = () => {
    stableProof.reset();
    const client = currentClient;
    const unbind = unbindCurrent;
    currentClient = null;
    unbindCurrent = null;
    try { unbind?.(); } catch {}
    try { client?.close(); } catch {}
    exitPresentationModes();
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
      stop(gamingWorkspace ? 'Flux du jeu fermé — arrêt de la session toujours disponible.' : 'Session vidéo fermée — arrêt de la session toujours disponible.');
      return;
    }

    const delay = NATIVE_RECONNECT_DELAYS_MS[
      Math.min(reconnectAttempt, NATIVE_RECONNECT_DELAYS_MS.length - 1)
    ];
    reconnectAttempt += 1;
    setStatus(gamingWorkspace ? 'Flux interrompu, reconnexion…' : 'Connexion interrompue, reconnexion…');
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

        if (state?.audioState === 'enabled') {
          if (audioEnableButton) {
            audioEnableButton.textContent = 'Son activé';
            audioEnableButton.setAttribute?.('aria-pressed', 'true');
          }
        } else if (state?.audioState === 'waiting-for-gesture' || state?.audioState === 'blocked') {
          if (audioEnableButton) {
            audioEnableButton.textContent = 'Activer le son';
            audioEnableButton.setAttribute?.('aria-pressed', 'false');
          }
        } else if (state?.audioState === 'closed' && audioEnableButton) {
          audioEnableButton.textContent = 'Son arrêté';
          audioEnableButton.setAttribute?.('aria-pressed', 'false');
        }
        if (state?.audioState) return;

        if (state?.state === 'closed') {
          // Record only WebSocket protocol metadata to diagnose the FIRST
          // closure, never a session URL, HTTP headers or video payload.
          if (Number.isInteger(state.closeCode)) {
            globalThis.console?.info?.('gpubnb_native_ws_closed', {
              code: state.closeCode,
              wasClean: state.wasClean === true,
            });
          }
          resetProof();
          stableProof.reset();
          const unbind = unbindCurrent;
          currentClient = null;
          unbindCurrent = null;
          try { unbind?.(); } catch {}
          exitPresentationModes();

          if (stopped) {
            setStatus(gamingWorkspace ? 'Flux du jeu fermé' : 'Session vidéo fermée');
            return;
          }
          // Render sends 1008 when the workspace authority expires/revokes.
          // Never retry a revoked browser session or obscure the security gate.
          if (state.closeCode === 1008) {
            stop(gamingWorkspace
              ? 'Session non autorisée — ouvrez une nouvelle réservation'
              : 'Session vidéo non autorisée — ouvrir une nouvelle session');
            return;
          }
          if (pageHidden) return;
          scheduleReconnect();
          return;
        }

        if (state?.state === 'ready') {
          const timestamp = proofNow();
          // The continuity engine requires rising frame sequence, same stream
          // epoch and no gap >3s throughout the 10s backoff recovery period.
          // A scheduled timer alone never proves video is being rendered.
          if (stableProof.observe(state, timestamp).video300sObserved) {
            markRecovered();
            stableProof.reset();
          }
          proof?.observe(state, timestamp);
        } else {
          stableProof.reset();
          resetProof();
        }
        showProof();

        const label = {
          connecting: gamingWorkspace
            ? (reconnectAttempt > 0 ? 'Reconnexion sécurisée au jeu…' : 'Connexion sécurisée au jeu…')
            : (reconnectAttempt > 0 ? 'Reconnexion sécurisée…' : 'Connexion sécurisée…'),
          connected: gamingWorkspace
            ? 'Canal authentifié, attente de l’image du jeu…'
            : 'Canal authentifié, attente de la première image…',
          ready: gamingWorkspace ? 'Flux du jeu actif' : 'Bureau distant actif',
        }[state?.state] ?? 'État inconnu';
        setStatus(label);
      },
      onError: (error) => {
        if (client !== currentClient) return;
        const code = safeNativeDesktopErrorCode(error);
        globalThis.console?.warn?.('gpubnb_native_client_error', code);
        setStatus(`Connexion interrompue — ${code}`);
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
    resetProof();
    cancelReconnect();
    releaseCurrent();
  };

  const onPageShow = () => {
    if (stopped) return;
    pageHidden = false;
    connect();
  };

  const stop = (statusMessage = gamingWorkspace ? 'Flux du jeu fermé' : 'Session vidéo fermée') => {
    if (stopped) return;
    stopped = true;
    if (proofTimer !== null) clearIntervalFn(proofTimer);
    resetProof();
    cancelReconnect();
    releaseCurrent();
    windowObject.removeEventListener?.('pagehide', onPageHide);
    windowObject.removeEventListener?.('pageshow', onPageShow);
    documentObject.removeEventListener?.('fullscreenchange', updateFullscreenButton);
    documentObject.removeEventListener?.('pointerlockchange', updatePointerLockButton);
    fullscreenButton?.removeEventListener?.('click', requestFullscreen);
    pointerLockButton?.removeEventListener?.('click', togglePointerLock);
    audioEnableButton?.removeEventListener?.('click', enableAudio);
    audioVolume?.removeEventListener?.('input', changeAudioVolume);
    // Closing the local viewer is not confirmation of server-side STOP.
    // Keep authenticated STOP available until the API acknowledges it.
    setStatus(statusMessage);
  };

  let stopRequestInFlight = false;
  const requestSessionStop = async () => {
    if (serverStopConfirmed || stopRequestInFlight) return;
    if (typeof apiFetch !== 'function' || !apiBase) {
      setStatus('Arrêt indisponible — ouvrez « Gérer la session ».');
      return;
    }
    stopRequestInFlight = true;
    if (stopSessionButton) stopSessionButton.disabled = true;
    setStatus(gamingWorkspace
      ? 'Arrêt demandé — GPUbnb libère le workspace…'
      : 'Arrêt demandé — GPUbnb va libérer la session…');
    try {
      const response = await apiFetch(
        `${apiBase}/workspace-sessions/${encodeURIComponent(sessionId)}/stop`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );
      if (!response?.ok) throw new Error('session_stop_failed');
      serverStopConfirmed = true;
      const message = gamingWorkspace
        ? 'Arrêt demandé au serveur — GPUbnb libère les ressources.'
        : 'Arrêt confirmé — GPUbnb libère la session.';
      if (stopped) setStatus(message);
      else stop(message);
      stopSessionButton?.removeEventListener?.('click', requestSessionStop);
    } catch {
      stopRequestInFlight = false;
      if (stopSessionButton) stopSessionButton.disabled = false;
      setStatus('Arrêt non confirmé — réessayez ou ouvrez « Gérer la session ».');
    }
  };

  closeButton.addEventListener('click', () => stop(), { once: true });
  stopSessionButton?.addEventListener('click', requestSessionStop);
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
    if (status) status.textContent = document.body?.dataset?.workspaceKind === 'gaming'
      ? 'Le Gaming Workspace n’est pas disponible.'
      : 'La session bureau n’est pas disponible.';
  }
}
