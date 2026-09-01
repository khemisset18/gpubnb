import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourcePromise = readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

function routeSlice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

test('new jobs are never assigned to an agent without the fencing protocol', async () => {
  const source = await sourcePromise;
  const body = routeSlice(source, "app.get('/agent/jobs/next/:machineId'", "app.get('/agent/jobs/:id/control'");
  assert.match(body, /supportsJobLeaseProtocol\(machine\.agentVersion\)/);
  assert.match(body, /agent_upgrade_required/);
  assert.match(body, /JOB_LEASE_PROTOCOL_VERSION/);
});

test('leased jobs have an independent signed renewal endpoint', async () => {
  const source = await sourcePromise;
  const body = routeSlice(source, "app.post('/agent/jobs/:id/lease'", "app.post('/agent/jobs/:id/control'");
  assert.match(body, /authenticatedAgentWithBody/);
  assert.match(body, /jobLeaseWhere/);
  assert.match(body, /jobLeaseExpiresAt/);
  assert.match(body, /stale_job_attempt/);
});

test('state and completion mutations are fenced by attempt plus token', async () => {
  const source = await sourcePromise;
  const state = routeSlice(source, "app.post('/agent/jobs/:id/state'", "app.post('/agent/jobs/:id/progress'");
  const complete = routeSlice(source, "app.post('/agent/jobs/:id/complete'", "app.post('/agent/jobs/:id/finalize-proof'");
  for (const body of [state, complete]) {
    assert.match(body, /jobLeaseFields/);
    assert.match(body, /executionWhere/);
    assert.match(body, /stale_job_attempt/);
    assert.match(body, /authenticatedAgentWithBody/);
  }
  assert.match(complete, /duplicate:true/, 'lost HTTP response retry must be idempotent after completion');
  assert.match(complete, /workspace_session_not_preparing/, 'completion must never reopen a terminal Developer session');
});

test('proof finalization cannot be replayed by an obsolete attempt', async () => {
  const source = await sourcePromise;
  const body = routeSlice(source, "app.post('/agent/jobs/:id/finalize-proof'", "app.get('/listings'");
  assert.match(body, /terminalExecutionMatches/);
  assert.match(body, /stale_job_attempt/);
  // The booking-completion/machine-release decision itself now lives in
  // completeGpuProofJob (gpu-proof-completion.ts) so it can be exercised directly
  // against a real database in gpu-proof-completion.test.ts, instead of being
  // re-simulated in a test that only reads server.ts's source text.
  assert.match(body, /completeGpuProofJob\(db,job\.bookingId,body\.machineId\)/);
  const completion = await readFile(new URL('../src/gpu-proof-completion.ts', import.meta.url), 'utf8');
  assert.match(completion, /moderationStatus:\s*ModerationStatus\.CLEAR/);
});

test('heartbeat derives availability from server-owned runtime state', async () => {
  const source = await sourcePromise;
  const body = routeSlice(source, "app.post('/agent/heartbeat'", "const publicWorkspace=");
  assert.match(body, /deriveHeartbeatOperational/);
  assert.match(body, /runtimeBooking/);
  assert.match(body, /runtimeSession/);
  assert.match(body, /runtimeJob/);
  assert.match(body, /operational:heartbeatOperational/);
  assert.match(body, /agentUpgradeRequired/);
  assert.match(body, /ListingStatus\.HIDDEN_OFFLINE/);
});

test('heartbeat publishability requires Docker and NVIDIA runtime, and hides the listing on ANY loss of publishability, not only an outdated agent', async () => {
  // Real divergence bug found in this session's audit: legacyPublishable used
  // to ignore dockerAvailable/nvidiaRuntimeAvailable entirely (computeMachineState,
  // the actual single source of truth used by createExactGpuListing and the Host
  // diagnostics page, already required both) - a listing could stay ACTIVE and
  // publicly bookable after Docker or the NVIDIA runtime went down on an already-
  // published host. And the listing was only ever force-hidden for the single
  // `!jobProtocolSupported` reason, never for any of the other ways publishable
  // could go false (GPU swap, failed CUDA probe, Docker/NVIDIA runtime loss) -
  // see docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md for the full incident writeup.
  const source = await sourcePromise;
  const body = routeSlice(source, "app.post('/agent/heartbeat'", "const publicWorkspace=");
  assert.match(body, /dockerOk=b\.dockerAvailable\?\?m\.dockerAvailable/);
  assert.match(body, /nvidiaRuntimeOk=b\.nvidiaRuntimeAvailable\?\?m\.nvidiaRuntimeAvailable/);
  assert.match(body, /legacyPublishable=m\.moderationStatus===ModerationStatus\.CLEAR&&sameGpu&&b\.cudaProbeOk&&jobProtocolSupported&&dockerOk&&nvidiaRuntimeOk/);
  assert.doesNotMatch(
    body,
    /else if\(!jobProtocolSupported\)await tx\.gpuListing\.updateMany/,
    'the listing must be hidden whenever publishable is false for ANY reason, not only an outdated agent',
  );
});
