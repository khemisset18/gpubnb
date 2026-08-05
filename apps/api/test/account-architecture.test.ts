import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const apiRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(apiRoot, '../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

const normalizedLines = (content: string) =>
  new Set(content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));

test('Netlify proxies same-origin API calls to Render', () => {
  const config = read('netlify.toml');
  const lines = normalizedLines(config);
  assert.ok(lines.has('from = "/api/*"'));
  assert.ok(lines.has('to = "https://gpubnb.onrender.com/:splat"'));
  assert.ok(lines.has('status = 200'));
  assert.ok(lines.has('force = true'));
  assert.match(read('apps/web/config.js'), /GPUBNB_API_URL = .+ "\/api"/);
});

test('professional account pages and protected API routes exist', () => {
  for (const page of ['apps/web/onboarding.html', 'apps/web/dashboard.html', 'apps/web/session.html']) {
    assert.match(read(page), /<title>/);
  }
  const server = read('apps/api/src/server.ts');
  for (const route of ["app.get('/profile'", "app.put('/profile'", "app.get('/dashboard'"]) {
    assert.ok(server.includes(route), route);
  }
});

test('Compute session has protected lifecycle, metrics and emergency stop', () => {
  const server = read('apps/api/src/server.ts');
  for (const route of [
    "app.post('/bookings/:bookingId/workspace-sessions'",
    "app.post('/workspace-sessions/:id/start'",
    "app.get('/workspace-sessions/:id'",
    "app.post('/workspace-sessions/:id/stop'",
    "app.post('/agent/workspace-sessions/:id/metrics'",
  ]) {
    assert.ok(server.includes(route), route);
  }
  const page = read('apps/web/session.html');
  for (const id of ['gpuMetric', 'vramMetric', 'usageMetric', 'stopSession']) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
});

test('Compute is prepared before renter arrival and access waits for READY', () => {
  const server = read('apps/api/src/server.ts');
  assert.match(server, /ensureComputePreparation/);
  assert.match(server, /JobType\.GPU_PROOF/);
  assert.match(server, /status:WorkspaceSessionStatus\.READY/);
  assert.match(server, /preparationProgress:100/);
  const script = read('apps/web/session.js');
  assert.match(script, /session\.status!==\'READY\'/);
  assert.match(read('apps/web/session.html'), /Pr?paration avant votre arriv?e/);
});

test('account schema separates private identity and user capabilities', () => {
  const schema = read('apps/api/prisma/schema.prisma');
  for (const field of [
    'email String? @unique',
    'firstName String?',
    'lastName String?',
    'canRent Boolean',
    'canHost Boolean',
    'profileCompletedAt DateTime?',
  ]) {
    assert.ok(schema.includes(field), field);
  }
});

test('workspace catalogue uses one responsive four-column grid', () => {
  const html = read('apps/web/workspaces.html');
  const css = read('apps/web/workspaces.css') + read('apps/web/workspaces-layout.css');
  const script = read('apps/web/workspaces.js');
  assert.match(html, /id="workspaceGrid"/);
  assert.match(css, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:900px\)/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(script, /\/workspaces/);
  assert.doesNotMatch(html, /Que souhaitez-vous faire aujourd/);
  for (const page of [
    'apps/web/index.html',
    'apps/web/publish.html',
    'apps/web/demandes.html',
    'apps/web/propositions.html',
  ]) {
    assert.match(read(page), /href="workspaces\.html">Espaces de travail/);
  }
});
