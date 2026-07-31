import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const webRoot = path.resolve(process.cwd(), '../web');

test('owner mining page exposes rental-first controls', async () => {
  const html = await readFile(path.join(webRoot, 'mining.html'), 'utf8');
  assert.match(html, /Location avant minage/);
  assert.match(html, /data-mining-machine/);
  assert.match(html, /data-mining-resources/);
  assert.match(html, /commission 1 %/i);
  assert.match(html, /commission 0 %/i);
  assert.match(html, /Reprise automatique désactivée par défaut/);
  assert.match(html, /mining\.js/);
});

test('mining UI uses owner-only API routes and optimistic concurrency', async () => {
  const script = await readFile(path.join(webRoot, 'mining.js'), 'utf8');
  assert.match(script, /request\('\/machines\/mine'\)/);
  assert.match(script, /\/mining-resources/);
  assert.match(script, /expectedVersion/);
  assert.match(script, /method:'PUT'/);
  assert.match(script, /activeRentalId\|\|resource\.quarantined/);
  assert.match(script, /autoResumeAfterRental:mode==='DISABLED'\?false/);
});

test('mining UI never asks owners for a raw pool password', async () => {
  const html = await readFile(path.join(webRoot, 'mining.html'), 'utf8');
  const script = await readFile(path.join(webRoot, 'mining.js'), 'utf8');
  assert.doesNotMatch(html, /type=["']password["']/i);
  assert.match(script, /Référence du secret/);
  assert.match(script, /Ne saisissez jamais un mot de passe brut/);
  assert.match(script, /ownerPoolSecretRef/);
});

test('dashboard links to mining without claiming the runtime is production-ready', async () => {
  const dashboard = await readFile(path.join(webRoot, 'dashboard.html'), 'utf8');
  assert.match(dashboard, /href="mining\.html"/);
  assert.match(dashboard, /Expérimental sécurisé/);
  assert.match(dashboard, /désactivé par défaut/);
  assert.doesNotMatch(dashboard, /Minage.*Fonctionnel/s);
});
