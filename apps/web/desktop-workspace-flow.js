'use strict';

export const DESKTOP_STREAMING_SLUGS = Object.freeze(['creator', 'cloud-desktop', 'cad', 'gaming']);

export function desktopWorkspacePhase(bookingStatus, detail) {
  if (!['FUNDED', 'STARTING', 'ACTIVE'].includes(bookingStatus) || !detail) return 'HIDDEN';
  if (detail.canOpen === true) return 'OPEN';
  if (detail.retryable === true) return 'RETRY';
  if (['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'FAILED'].includes(detail.status)) return 'ENDED';
  return 'PREPARING';
}

export function validDesktopSlug(value) {
  return DESKTOP_STREAMING_SLUGS.includes(value);
}
