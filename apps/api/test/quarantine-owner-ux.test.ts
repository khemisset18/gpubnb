import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourcePromise = readFile(new URL('../../web/machine-diagnostics.js', import.meta.url), 'utf8');
const htmlPromise = readFile(new URL('../../web/machine-diagnostics.html', import.meta.url), 'utf8');

test('quarantine UI shows the durable cause and exposes one automatic resolution action', async () => {
  const [source, html] = await Promise.all([sourcePromise, htmlPromise]);
  assert.match(source, /Cause détectée/);
  assert.match(source, /Résoudre automatiquement/);
  assert.match(source, /startAutomaticResolution/);
  assert.match(html, /data-md-repair[^>]*>Résoudre automatiquement</);
});

test('one-click resolution chains safe repair then a real diagnostic, never a force clear', async () => {
  const source = await sourcePromise;
  const start = source.indexOf('async function startAutomaticResolution');
  const end = source.indexOf("document.addEventListener('DOMContentLoaded'", start);
  assert.ok(start >= 0 && end > start);
  const resolver = source.slice(start, end);
  assert.match(resolver, /\/diagnostics\/repair/);
  assert.match(resolver, /\/diagnostics\/rerun/);
  assert.ok(resolver.indexOf('/diagnostics/repair') < resolver.indexOf('/diagnostics/rerun'));
  assert.doesNotMatch(resolver, /force-clear|moderationStatus|ProgramData/i);
});
