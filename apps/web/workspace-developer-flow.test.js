import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeveloperPhase,
  deriveDeveloperPhase,
  isGpuProofCompleted,
  isBookingEligibleForWorkspace,
  preparationLabel,
  resolveWorkspaceOpenUrl,
} from './workspace-developer-flow.js';

// A. GPU_PROOF COMPLETED -> bouton "Créer mon espace"
test('shows CREATE once GPU_PROOF is COMPLETED and no developer session exists yet', () => {
  const phase = deriveDeveloperPhase({
    bookingStatus: 'ACTIVE',
    gpuProofJob: { status: 'COMPLETED' },
    workspaceDetail: null,
  });
  assert.equal(phase, DeveloperPhase.CREATE);
});

test('stays HIDDEN while GPU_PROOF has not completed', () => {
  for (const status of ['QUEUED', 'RUNNING', 'UPLOADING_RESULTS', 'FAILED', 'TIMED_OUT']) {
    const phase = deriveDeveloperPhase({
      bookingStatus: 'ACTIVE',
      gpuProofJob: { status },
      workspaceDetail: null,
    });
    assert.equal(phase, DeveloperPhase.HIDDEN, `status=${status}`);
  }
});

test('stays HIDDEN when there is no GPU_PROOF job at all', () => {
  const phase = deriveDeveloperPhase({ bookingStatus: 'ACTIVE', gpuProofJob: null, workspaceDetail: null });
  assert.equal(phase, DeveloperPhase.HIDDEN);
});

test('stays HIDDEN when the booking itself is not in an eligible status', () => {
  for (const bookingStatus of ['AWAITING_DEPOSIT', 'CREATED', 'COMPLETED', 'CANCELLED', 'DEGRADED']) {
    const phase = deriveDeveloperPhase({
      bookingStatus,
      gpuProofJob: { status: 'COMPLETED' },
      workspaceDetail: null,
    });
    assert.equal(phase, DeveloperPhase.HIDDEN, `bookingStatus=${bookingStatus}`);
  }
});

// C. Polling -> canOpen=true
test('switches to OPEN as soon as canOpen is true, regardless of raw status', () => {
  const phase = deriveDeveloperPhase({
    bookingStatus: 'ACTIVE',
    gpuProofJob: { status: 'COMPLETED' },
    workspaceDetail: { status: 'READY', canOpen: true, retryable: false },
  });
  assert.equal(phase, DeveloperPhase.OPEN);
});

test('stays PREPARING while the developer session exists but is not openable yet', () => {
  const phase = deriveDeveloperPhase({
    bookingStatus: 'ACTIVE',
    gpuProofJob: { status: 'COMPLETED' },
    workspaceDetail: { status: 'PREPARING', canOpen: false, retryable: false },
  });
  assert.equal(phase, DeveloperPhase.PREPARING);
});

// Regression test for the incident where the raw session status was already
// READY (the container/runtime finished preparing) but the gateway tunnel had
// not registered yet (connectionMetadata still null) - the UI must never
// treat that as openable just because the underlying status string is READY.
test('stays PREPARING when status is READY but the gateway has not registered (canOpen false)', () => {
  const phase = deriveDeveloperPhase({
    bookingStatus: 'ACTIVE',
    gpuProofJob: { status: 'COMPLETED' },
    workspaceDetail: { status: 'READY', canOpen: false, retryable: false },
  });
  assert.equal(phase, DeveloperPhase.PREPARING);
});

test('offers RETRY when the developer session failed but is still retryable', () => {
  const phase = deriveDeveloperPhase({
    bookingStatus: 'ACTIVE',
    gpuProofJob: { status: 'COMPLETED' },
    workspaceDetail: { status: 'FAILED', canOpen: false, retryable: true },
  });
  assert.equal(phase, DeveloperPhase.RETRY);
});

test('reports ENDED for a terminal, non-retryable developer session', () => {
  const phase = deriveDeveloperPhase({
    bookingStatus: 'ACTIVE',
    gpuProofJob: { status: 'COMPLETED' },
    workspaceDetail: { status: 'COMPLETED', canOpen: false, retryable: false },
  });
  assert.equal(phase, DeveloperPhase.ENDED);
});

// B. Idempotence de la création (au niveau de la dérivation d'état) : une fois
// qu'un workspaceDetail existe (session déjà créée), CREATE ne doit plus jamais
// être proposé, quel que soit son statut interne.
test('never offers CREATE again once a developer workspace session exists', () => {
  const statuses = ['PREPARING', 'READY', 'RUNNING', 'STOP_REQUESTED', 'STOPPING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'];
  for (const status of statuses) {
    const phase = deriveDeveloperPhase({
      bookingStatus: 'ACTIVE',
      gpuProofJob: { status: 'COMPLETED' },
      workspaceDetail: { status, canOpen: status === 'READY' || status === 'RUNNING', retryable: ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(status) },
    });
    assert.notEqual(phase, DeveloperPhase.CREATE, `status=${status}`);
  }
});

test('isGpuProofCompleted / isBookingEligibleForWorkspace helpers', () => {
  assert.equal(isGpuProofCompleted({ status: 'COMPLETED' }), true);
  assert.equal(isGpuProofCompleted({ status: 'RUNNING' }), false);
  assert.equal(isGpuProofCompleted(null), false);
  assert.equal(isBookingEligibleForWorkspace('ACTIVE'), true);
  assert.equal(isBookingEligibleForWorkspace('CREATED'), false);
});

test('preparationLabel falls back to a generic message for unknown/missing phases', () => {
  assert.equal(preparationLabel({ preparation: { phase: 'DOWNLOADING_IMAGE' } }), 'Téléchargement de l’image…');
  assert.equal(preparationLabel({ preparation: { phase: 'SOMETHING_NEW' } }), 'Préparation en cours…');
  assert.equal(preparationLabel(null), 'Préparation en cours…');
});

test('preparationLabel describes GATEWAY_NOT_READY distinctly from a generic message', () => {
  assert.equal(preparationLabel({ preparation: { phase: 'GATEWAY_NOT_READY' } }), 'Connexion de l’espace de travail…');
});

// D. "Ouvrir mon espace" utilise l'URL réellement retournée par l'API.
test('resolveWorkspaceOpenUrl joins the gateway origin with exactly the server-provided openPath', () => {
  const url = resolveWorkspaceOpenUrl('https://gpubnb.onrender.com', {
    token: 'abc',
    expiresIn: 60,
    openPath: '/workspace-gateway/cmabc123/connect?grant=abc',
  });
  assert.equal(url, 'https://gpubnb.onrender.com/workspace-gateway/cmabc123/connect?grant=abc');
});

test('resolveWorkspaceOpenUrl tolerates a trailing slash on the configured gateway base', () => {
  const url = resolveWorkspaceOpenUrl('https://gpubnb.onrender.com/', { openPath: '/workspace-gateway/x/connect' });
  assert.equal(url, 'https://gpubnb.onrender.com/workspace-gateway/x/connect');
});

test('resolveWorkspaceOpenUrl refuses to fabricate a URL when the API omitted openPath', () => {
  assert.throws(() => resolveWorkspaceOpenUrl('https://gpubnb.onrender.com', { token: 'abc' }), /workspace_access_response_invalid/);
});

test('resolveWorkspaceOpenUrl refuses a non-relative openPath (defense in depth against a compromised/misbehaving API response)', () => {
  assert.throws(
    () => resolveWorkspaceOpenUrl('https://gpubnb.onrender.com', { openPath: 'https://evil.example/x' }),
    /workspace_access_response_invalid/,
  );
});
