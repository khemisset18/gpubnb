import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('marketplace exposes a busy state and the actual dynamic release time', async () => {
  const source = (await readFile(new URL('../src/server.ts', import.meta.url), 'utf8')).replace(/\s+/g, '');
  assert.match(source, /BookingStatus\.AWAITING_DEPOSIT,BookingStatus\.FUNDED,BookingStatus\.STARTING,BookingStatus\.ACTIVE/);
  assert.match(source, /state:'WORKING',label:'Entravail',availableAt:active\.endsAt/);
  assert.match(source, /state:'RENTED',label:'Enlocation',availableAt:active\.endsAt/);
});

test('marketplace disables rental while the GPU is rented or working', async () => {
  const source = (await readFile(new URL('../../web/app.js', import.meta.url), 'utf8')).replace(/\s+/g, '');
  assert.match(source, /x\.availability\.state!=='AVAILABLE'/);
  assert.match(source, /choose\.disabled=true/);
  assert.match(source, /ChoisirceGPUetmonespace/);
});
