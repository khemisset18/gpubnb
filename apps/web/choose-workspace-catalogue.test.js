import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./choose-workspace.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('./choose-workspace.js', import.meta.url), 'utf8');

test('workspace count comes from live catalogue, not an obsolete fixed 13', () => {
  assert.match(html, /id="workspaceCatalogueHeading"/);
  assert.doesNotMatch(html, /Les 13 Workspaces GPUbnb/);
  assert.match(js, /catalogue\.workspaces\.length/);
});

test('unqualified new studios display an explicit non-bookable notice', () => {
  assert.match(js, /En préparation — non réservable/);
  assert.match(js, /Expérimental — non réservable/);
  assert.match(js, /workspace\.bookable\?/);
  // Only Compute remains available for direct checkout in the private beta.
  assert.match(js, /workspace\.slug==='compute'/);
});
