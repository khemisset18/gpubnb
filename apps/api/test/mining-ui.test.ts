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
  assert.match(html, /Pool personnel opérationnel\s*:\s*aucune commission GPUbnb/i);
  assert.match(html, /Pool GPUbnb futur\s*:\s*1 % de commission, actuellement désactivé/i);
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
  assert.match(script, /Référence locale du secret/);
  assert.match(script, /Ne saisissez jamais un mot de passe brut/);
  assert.match(script, /ownerPoolSecretRef/);
  assert.match(script, /maxlength="128"/);
  assert.match(script, /secret:\/\/local\/mining\/\[A-Za-z0-9\]/);
});

test('dashboard links to mining without claiming the runtime is production-ready', async () => {
  const dashboard = await readFile(path.join(webRoot, 'dashboard.html'), 'utf8');
  assert.match(dashboard, /href="mining\.html"/);
  assert.match(dashboard, /Expérimental sécurisé/);
  assert.match(dashboard, /désactivé par défaut/);
  assert.doesNotMatch(dashboard, /Minage.*Fonctionnel/s);
});


test('mining UI exposes only the currently executable operational scope', async () => {
  const script = await readFile(path.join(webRoot, 'mining.js'), 'utf8');
  assert.match(script, /lolminer_blake3/);
  assert.match(script, /lolminer_etchash/);
  assert.match(script, /lolminer_octopus/);
  assert.doesNotMatch(script, /trex_rvn_kawpow/);
  assert.doesNotMatch(script, /teamredminer_rvn_kawpow/);
  assert.doesNotMatch(script, /option value="GPUBNB_MANAGED"/);
  assert.match(script, /resource\.kind==='GPU'\?85:50/);
  assert.match(script, /max="98"/);
  assert.doesNotMatch(script, /name="gpuIntensityPercent"/);
  assert.match(script, /secret:\/\/local\/mining\/pool-main/);
});
