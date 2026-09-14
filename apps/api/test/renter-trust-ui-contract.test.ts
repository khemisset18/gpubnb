import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../../', import.meta.url);

async function read(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('marketplace trust copy is evidence-based and does not invent reliability', async () => {
  const page = await read('apps/web/index.html');

  assert.match(page, /Annonce active \+ machine actuellement en ligne/);
  assert.match(page, /modèle GPU, la VRAM, le pilote et la compatibilité affichés proviennent des mesures Agent disponibles/);
  assert.match(page, /GPUbnb n’invente ni note, ni avis, ni pourcentage de fiabilité/);
  assert.doesNotMatch(page, /99,2\s*%/);
  assert.doesNotMatch(page, /stabilité démo/i);
});

test('homepage privacy copy does not claim renter access to the owner desktop', async () => {
  const page = await read('apps/web/index.html');
  assert.match(page, /aucun accès au bureau hôte/i);
});
