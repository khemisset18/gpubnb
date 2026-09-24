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
  assert.match(html, /Commission GPUbnb\s*:\s*1 %/i);
  assert.match(html, /Pool personnel\s*:\s*aucune commission GPUbnb/i);
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


test('mining UI consumes the server-authoritative runtime catalog and thermal policy', async () => {
  const script = await readFile(path.join(webRoot, 'mining.js'), 'utf8');
  assert.match(script, /request\('\/mining\/catalog'\)/);
  assert.match(script, /miningCatalog\.profiles\.filter/);
  assert.match(script, /miningCatalog\.thermalLimits\[resource\.kind\]/);
  assert.match(script, /thermalMinimum/);
  assert.match(script, /thermalMaximum/);
  assert.doesNotMatch(script, /trex_rvn_kawpow|teamredminer_rvn_kawpow|lolminer_etc_etchash|lolminer_erg_autolykos2|lolminer_flux_zelhash/);
});

test('mining UI displays only signed current resource telemetry without inventing revenue', async () => {
  const script = await readFile(path.join(webRoot, 'mining.js'), 'utf8');
  const start = script.indexOf('function renderMiningTelemetry(resource)');
  const end = script.indexOf('function renderResource(resource)', start);
  assert.ok(start >= 0 && end > start);
  const telemetryRenderer = script.slice(start, end);
  assert.match(telemetryRenderer, /lastMiningTelemetry/);
  assert.match(telemetryRenderer, /Hashrate/);
  assert.match(telemetryRenderer, /Parts A\/S\/Hw/);
  assert.match(telemetryRenderer, /Aucun revenu n’est estimé/);
  assert.doesNotMatch(
    telemetryRenderer,
    /walletAddress|workerName|ownerPoolEndpoint|ownerPoolSecretRef|pid|executablePath|logPath|commandId/,
  );
});
