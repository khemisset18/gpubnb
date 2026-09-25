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


test('mining runtime controls call owner start-stop endpoints without browser-supplied runtime payloads', async () => {
  const script = await readFile(path.join(webRoot, 'mining.js'), 'utf8');
  assert.match(script, /data-start-mining/);
  assert.match(script, /data-stop-mining/);
  assert.match(script, /mining-resources\/\$\{encodeURIComponent\(form\.dataset\.resourceId\)\}\/\$\{action\}/);
  assert.match(script, /\{method:'POST'\}/);
  const runtimeActionStart = script.indexOf('async function requestRuntimeAction');
  const runtimeActionEnd = script.indexOf('async function saveConfiguration', runtimeActionStart);
  const runtimeAction = script.slice(runtimeActionStart, runtimeActionEnd);
  assert.doesNotMatch(runtimeAction, /ownerPoolEndpoint|walletAddress|hardwareUuid|runtimeGeneration|fencingToken|maximumTemperatureC|maximumPowerWatts/);
});

test('mining runtime buttons fail closed during rental quarantine and transitional states', async () => {
  const script = await readFile(path.join(webRoot, 'mining.js'), 'utf8');
  assert.match(script, /\['STARTING','VERIFYING_STOP','PREEMPTING'\]/);
  assert.match(script, /!resourceLocked\(resource\)/);
  assert.match(script, /resource\.runtimeState==='MINING'/);
});


test('owner mining UI marks heartbeat telemetry stale after two minutes', async () => {
  const script = await readFile(path.join(webRoot, 'mining.js'), 'utf8');
  assert.match(script, /MINING_TELEMETRY_FRESH_MS=120000/);
  assert.match(script, /Télémétrie Agent périmée/);
  assert.match(script, /Les anciennes métriques ne sont pas affichées comme valeurs actuelles/);
  assert.match(script, /Télémétrie fraîche/);
});

test('owner mining UI renders only structured heartbeat metrics', async () => {
  const script = await readFile(path.join(webRoot, 'mining.js'), 'utf8');
  const start = script.indexOf('function renderLiveTelemetry');
  const end = script.indexOf('function runtimeControls', start);
  const block = script.slice(start, end);
  for (const field of ['hashrate','hashrateUnit','temperatureC','powerWatts','utilizationPercent','acceptedShares','staleShares','hardwareErrors','poolConnected','uptimeSeconds']) {
    assert.match(block, new RegExp(field));
  }
  assert.doesNotMatch(block, /wallet|poolUrl|ownerPoolEndpoint|workerName|logPath|executablePath|commandId|fencingToken|runtimeGeneration/i);
});


test('mining UI consumes the server-authoritative runtime catalog and thermal policy', async () => {
  const script = await readFile(path.join(webRoot, 'mining.js'), 'utf8');
  assert.match(script, /request\('\/mining\/catalog'\)/);
  assert.match(script, /miningCatalog\.profiles\.filter/);
  assert.match(script, /miningCatalog\.thermalLimits\[resource\.kind\]/);
  assert.match(script, /thermalMinimum/);
  assert.match(script, /thermalMaximum/);
  assert.doesNotMatch(script, /const MINING_PROFILES/);
  assert.doesNotMatch(script, /trex_rvn_kawpow|teamredminer_rvn_kawpow|lolminer_etc_etchash|lolminer_erg_autolykos2|lolminer_flux_zelhash/);
});
