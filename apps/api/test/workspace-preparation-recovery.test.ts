import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('workspace progress reports are authenticated, fenced and refresh the explicit lease', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/jobs/:id/progress'");
  assert.ok(start >= 0, 'the signed agent progress endpoint must exist');
  const body = source.slice(start, source.indexOf("app.post('/agent/jobs/:id/logs'", start));
  assert.match(body, /authenticatedAgentWithBody/, 'progress reports must use body-bound V2 agent authentication');
  assert.match(body, /type:JobType\.WORKSPACE_PREPARE/, 'the endpoint must be scoped to workspace preparation jobs');
  assert.match(body, /executionWhere/, 'progress must be fenced to the current attempt and lease');
  assert.match(body, /executionRefresh/, 'real progress must renew the explicit execution lease');
  assert.match(body, /stale_job_attempt/, 'an obsolete worker must receive a stable fencing error');
  assert.match(body, /preparationStep:body\.step/, 'the renter-visible preparation condition must be updated');
});

test('Developer workspace retry remains restricted to terminal sessions and creates one new immutable attempt', async () => {
  const source = await readFile(new URL('../src/workspace-renter-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/bookings/:bookingId/workspace/retry'");
  assert.ok(start >= 0, 'the renter retry endpoint must exist in the Developer module');
  const body = source.slice(start, source.indexOf("app.get('/bookings/:bookingId/workspace'", start));
  assert.match(body, /status:\{in:retryableSessions\}/, 'retry must never duplicate an active preparation');
  assert.match(body, /status:\{notIn:terminalJobs\}/, 'an active job must block retry');
  assert.match(body, /preparationAttempts:\{increment:1\}/, 'each retry must be auditable as a new attempt');
  assert.match(body, /type:JobType\.WORKSPACE_PREPARE/, 'retry must create a real agent job');
});

test('Developer workspace status module still exposes phase, elapsed time, last activity and terminal error', async () => {
  const source = await readFile(new URL('../src/workspace-renter-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/bookings/:bookingId/workspace'");
  const body = source.slice(start, source.indexOf("app.post('/bookings/:bookingId/workspace/access'", start));
  const fields: Record<string, RegExp> = {
    phase: /\n\s*phase,/,
    elapsedSeconds: /elapsedSeconds:/,
    updatedAt: /updatedAt:/,
    jobStatus: /jobStatus:/,
    errorCode: /errorCode:/,
  };
  for (const [field, pattern] of Object.entries(fields)) assert.match(body, pattern, `preparation status must expose ${field}`);
});

test('private-beta renter UI separates current Compute reservations from collapsed history', async () => {
  const source = await readFile(new URL('../../web/workspace-bookings.js', import.meta.url), 'utf8');
  assert.match(source, /currentBookingStatuses/, 'current reservations need an explicit classification');
  assert.match(source, /<details class="workspace-history">/, 'terminal reservations must be grouped in collapsed history');
  assert.match(source, /data-prepare-compute/, 'funded reservations without a proof job must expose Compute preparation');
  assert.doesNotMatch(source, /data-prepare-developer/, 'private-beta recovery must not silently switch the renter to Developer');
});

// Real live incident (2026-09-02): a FAILED GPU_PROOF job had no recovery path at all -
// ensureComputePreparation only ever returns the existing (already-broken) session instead of
// creating a fresh job, and this route used to exclude 'compute' from its retryable slugs
// entirely, forcing an abandoned booking with no way to reopen a Developer workspace.
test('workspace retry now covers a failed Compute/GPU_PROOF session too, creating the correct job type', async () => {
  const source = await readFile(new URL('../src/workspace-renter-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/bookings/:bookingId/workspace/retry'");
  const body = source.slice(start, source.indexOf("app.get('/bookings/:bookingId/workspace'", start));
  assert.match(body, /slug:\{in:\['compute','developer','data','ai','video','audio','api','mobile','security-lab'\]\}/, 'compute must be retry-eligible alongside every other workspace type');
  assert.match(body, /const isCompute=workspaceSlug==='compute'/, 'the branch must be keyed off the actual session slug, not assumed');
  assert.match(body, /type:JobType\.GPU_PROOF,parameters:\{durationSeconds:Math\.max\(30,Math\.min\(600,row\.booking\.expectedSeconds\)\),workspaceSlug:'compute'\}/, 'a compute retry must create a real GPU_PROOF job shaped exactly like ensureComputePreparation\'s, not a WORKSPACE_PREPARE job the agent would never treat as GPU_PROOF');
  assert.match(body, /const activeJobType=isCompute\?JobType\.GPU_PROOF:JobType\.WORKSPACE_PREPARE/, 'the "already active" guard must check the right job type per slug, or a stuck WORKSPACE_PREPARE could never block a duplicate GPU_PROOF retry and vice versa');
  assert.match(body, /runBookingTransaction\(db,async tx=>\{[\s\S]*?isolationLevel:Prisma\.TransactionIsolationLevel\.Serializable/, 'the retry transaction must be retried on a transient serialization conflict, not just wrapped once');
});

test('private-beta renter UI keeps the latest terminal GPU_PROOF failure visible', async () => {
  const source = await readFile(new URL('../../web/workspace-bookings.js', import.meta.url), 'utf8');
  assert.match(source, /latestFailure/, 'the newest failed GPU proof must be promoted above collapsed history');
  assert.match(source, /workspace-latest-failure/, 'the visible failure needs a stable UI surface');
  assert.match(source, /role="alert"/, 'assistive technology must announce the terminal failure');
  assert.match(source, /errorCode/, 'the real GPU_PROOF error code must stay visible to the renter');
  assert.match(source, /Aucun basculement automatique vers Developer/, 'the UI must explain that it does not silently change workspace type');
});
