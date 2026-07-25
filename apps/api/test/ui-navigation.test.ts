import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const webRoot=path.resolve(process.cwd(),'../web');
const pages=['dashboard.html','host-install.html','machines.html','listings.html','bookings.html','revenues.html'];

test('portal pages expose accessible navigation and real targets',async()=>{
  for(const page of pages){
    const html=await readFile(path.join(webRoot,page),'utf8');
    assert.match(html,/portal\.css/);
    assert.match(html,/portal\.js/);
    assert.doesNotMatch(html,/href=["']#["']/);
    assert.doesNotMatch(html,/javascript:/i);
  }
});

test('installer buttons are disabled until stable artifacts exist',async()=>{
  const html=await readFile(path.join(webRoot,'host-install.html'),'utf8');
  assert.match(html,/Windows/);
  assert.match(html,/Linux/);
  assert.match(html,/macOS/);
  assert.equal((html.match(/Téléchargement indisponible/g)||[]).length,3);
  assert.equal((html.match(/disabled/g)||[]).length>=3,true);
});

test('dashboard does not present mining as operational',async()=>{
  const html=await readFile(path.join(webRoot,'dashboard.html'),'utf8');
  assert.match(html,/Expérimental/);
  assert.match(html,/Minage/);
  assert.match(html,/Indisponible/);
});