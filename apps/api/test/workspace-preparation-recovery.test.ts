import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('workspace progress reports are authenticated and refresh the job staleness clock', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/agent/jobs/:id/progress'");
  assert.ok(start >= 0, 'the signed agent progress endpoint must exist');
  const body = source.slice(start, source.indexOf("app.post('/agent/jobs/:id/logs'", start));
  assert.match(body, /authenticatedAgentWithBody/, 'progress reports must use body-bound V2 agent authentication');
  assert.match(body, /type:JobType\.WORKSPACE_PREPARE/, 'the endpoint must be scoped to workspace preparation jobs');
  assert.match(body, /data:\{updatedAt:now\}/, 'real progress must refresh the staleness clock');
  assert.match(body, /preparationStep:body\.step/, 'the renter-visible preparation condition must be updated');
});

test('workspace retry is restricted to terminal sessions and creates one new immutable attempt', async () => {
  const source = await readFile(new URL('../src/workspace-renter-routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/bookings/:bookingId/workspace/retry'");
  assert.ok(start >= 0, 'the renter retry endpoint must exist');
  const body = source.slice(start, source.indexOf("app.get('/bookings/:bookingId/workspace'", start));
  assert.match(body, /status:\{in:retryableSessions\}/, 'retry must never duplicate an active preparation');
  assert.match(body, /status:\{notIn:terminalJobs\}/, 'an active job must block retry');
  assert.match(body, /preparationAttempts:\{increment:1\}/, 'each retry must be auditable as a new attempt');
  assert.match(body, /type:JobType\.WORKSPACE_PREPARE/, 'retry must create a real agent job');
});

test('workspace status exposes phase, elapsed time, last activity and terminal error', async () => {
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

test('the renter UI separates current reservations from collapsed history', async () => {
  const source = await readFile(new URL('../../web/workspace-bookings.js', import.meta.url), 'utf8');
  assert.match(source, /currentBookingStatuses/, 'current reservations need an explicit classification');
  assert.match(source, /<details class="workspace-history">/, 'terminal reservations must be grouped in collapsed history');
  assert.match(source, /data-retry-workspace/, 'retryable failures must expose a recovery action');
});
