'use strict';
// Pure decision logic for the Developer workspace button on bookings.html.
// No DOM/fetch access here on purpose: this module is imported directly by
// workspace-developer-flow.test.js (Node's test runner) as well as by
// workspace-bookings.js in the browser, so it must stay side-effect free.

export const DeveloperPhase = Object.freeze({
  HIDDEN: 'HIDDEN',
  CREATE: 'CREATE',
  PREPARING: 'PREPARING',
  OPEN: 'OPEN',
  RETRY: 'RETRY',
  ENDED: 'ENDED',
});

const ELIGIBLE_BOOKING_STATUSES = new Set(['FUNDED', 'STARTING', 'ACTIVE']);
const ENDED_SESSION_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'FAILED']);

export function isGpuProofCompleted(gpuProofJob) {
  return !!gpuProofJob && gpuProofJob.status === 'COMPLETED';
}

export function isBookingEligibleForWorkspace(bookingStatus) {
  return ELIGIBLE_BOOKING_STATUSES.has(bookingStatus);
}

/**
 * @param {{bookingStatus:string, gpuProofJob:{status:string}|null, workspaceDetail:{canOpen:boolean,retryable:boolean,status:string}|null}} input
 * @returns {string} one of DeveloperPhase
 */
export function deriveDeveloperPhase({ bookingStatus, gpuProofJob, workspaceDetail }) {
  if (!isBookingEligibleForWorkspace(bookingStatus)) return DeveloperPhase.HIDDEN;
  if (!isGpuProofCompleted(gpuProofJob)) return DeveloperPhase.HIDDEN;
  if (!workspaceDetail) return DeveloperPhase.CREATE;
  if (workspaceDetail.canOpen) return DeveloperPhase.OPEN;
  if (workspaceDetail.retryable) return DeveloperPhase.RETRY;
  if (ENDED_SESSION_STATUSES.has(workspaceDetail.status)) return DeveloperPhase.ENDED;
  return DeveloperPhase.PREPARING;
}

const PREPARATION_PHASE_LABEL = {
  RECONNECTING_AGENT: 'Reconnexion à l’hôte…',
  VERIFYING_WORKSPACE: 'Vérification de l’espace…',
  VERIFYING_IMAGE: 'Vérification de l’image…',
  DOWNLOADING_IMAGE: 'Téléchargement de l’image…',
  STARTING_WORKSPACE: 'Démarrage de l’espace…',
  WAITING_FOR_HOST: 'En attente de l’hôte…',
  GATEWAY_NOT_READY: 'Connexion de l’espace de travail…',
};

export function preparationLabel(workspaceDetail) {
  const phase = workspaceDetail?.preparation?.phase;
  return (phase && PREPARATION_PHASE_LABEL[phase]) || 'Préparation en cours…';
}

// The commercial rental clock starts only once the workspace is genuinely activated
// (a real upstream frame proven exchanged with the renter's browser - see
// activateGatewaySession in workspace-gateway.ts), never at funding/GPU Proof/click
// time. workspaceDetail.status reads 'RUNNING' only after that real activation - READY
// (container ready, not yet actually opened) and PREPARING must never show a countdown.
// endsAt is always the server's own value (booking.endsAt, refreshed by the normal
// polling cycle); nowMs is the only locally-supplied input, so a fast local re-render
// can update the displayed count every second without hitting the network, while the
// authoritative anchor stays server-derived.
export function remainingRentalSeconds(workspaceDetail, nowMs) {
  if (!workspaceDetail || workspaceDetail.status !== 'RUNNING' || !workspaceDetail.endsAt) return null;
  const endsAtMs = new Date(workspaceDetail.endsAt).getTime();
  if (!Number.isFinite(endsAtMs)) return null;
  return Math.max(0, Math.round((endsAtMs - nowMs) / 1000));
}

export function formatRemainingRentalTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Builds the URL to navigate to for opening the workspace. Uses only the
 * `openPath` returned by POST /bookings/:id/workspace/access — never
 * fabricates a path itself. gatewayBase must be the WebSocket-capable
 * origin (window.GPUBNB_GATEWAY_URL), not the (possibly proxied) API base.
 * @param {string} gatewayBase
 * @param {{openPath:string}} accessResponse
 */
export function resolveWorkspaceOpenUrl(gatewayBase, accessResponse) {
  if (!accessResponse || typeof accessResponse.openPath !== 'string' || !accessResponse.openPath.startsWith('/')) {
    throw new Error('workspace_access_response_invalid');
  }
  return `${String(gatewayBase || '').replace(/\/$/, '')}${accessResponse.openPath}`;
}
