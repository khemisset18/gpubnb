import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeveloperPhase,
  deriveDeveloperPhase,
  isGpuProofCompleted,
  isBookingEligibleForWorkspace,
  preparationLabel,
  resolveWorkspaceOpenUrl,
  remainingRentalSeconds,
  formatRemainingRentalTime,
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

// Real bug found live during the PC A <-> PC B test: GPU Proof (~8 min) and any wait
// before the renter opens their workspace must never eat into a 15-minute rental - the
// commercial clock only starts once the workspace is genuinely RUNNING (a real upstream
// frame proven exchanged - see activateGatewaySession, workspace-gateway.ts), never at
// funding, GPU Proof, or merely clicking the button.
test('remainingRentalSeconds shows nothing before the workspace is genuinely RUNNING', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const futureEndsAt = new Date(now + 15 * 60_000).toISOString();
  for (const status of ['PREPARING', 'READY', 'STOP_REQUESTED', 'STOPPING', 'COMPLETED', 'FAILED']) {
    assert.equal(remainingRentalSeconds({ status, endsAt: futureEndsAt }, now), null, `status=${status}`);
  }
  assert.equal(remainingRentalSeconds(null, now), null);
  assert.equal(remainingRentalSeconds({ status: 'RUNNING', endsAt: null }, now), null);
});

test('remainingRentalSeconds derives the count purely from the server-provided endsAt, not a client-side start time', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  // 8 minutes of GPU Proof + waiting before the workspace opened must not have been
  // deducted - endsAt itself already reflects a full 15 minutes from real activation.
  const endsAt = new Date(now + 15 * 60_000).toISOString();
  assert.equal(remainingRentalSeconds({ status: 'RUNNING', endsAt }, now), 15 * 60);
});

test('remainingRentalSeconds never goes negative once the deadline has passed', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const pastEndsAt = new Date(now - 5_000).toISOString();
  assert.equal(remainingRentalSeconds({ status: 'RUNNING', endsAt: pastEndsAt }, now), 0);
});

test('remainingRentalSeconds is a pure function of (workspaceDetail, now) - a refresh or reconnect that re-reads the same server endsAt yields the exact same countdown, never a reset', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const detail = { status: 'RUNNING', endsAt: new Date(now + 600_000).toISOString() };
  assert.equal(remainingRentalSeconds(detail, now), remainingRentalSeconds(detail, now));
  // Simulate a page refresh 90s later against the same stored endsAt: strictly less
  // remaining time, never reset back up to the full duration.
  assert.equal(remainingRentalSeconds(detail, now + 90_000), 510);
});

test('formatRemainingRentalTime formats minutes:seconds, and hours:minutes:seconds past an hour', () => {
  assert.equal(formatRemainingRentalTime(0), '00:00');
  assert.equal(formatRemainingRentalTime(65), '01:05');
  assert.equal(formatRemainingRentalTime(15 * 60), '15:00');
  assert.equal(formatRemainingRentalTime(3661), '1:01:01');
});
