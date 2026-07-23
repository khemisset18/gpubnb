import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const apiRoot=resolve(import.meta.dirname,'..');
const repoRoot=resolve(apiRoot,'../..');
const read=(path:string)=>readFileSync(resolve(repoRoot,path),'utf8');

test('Netlify proxies same-origin API calls to Render',()=>{
 const config=read('netlify.toml');
 assert.match(config,/from="\/api\/\*"/);
 assert.match(config,/to="https:\/\/gpubnb\.onrender\.com\/:splat"/);
 assert.match(read('apps/web/config.js'),/GPUBNB_API_URL = .+ "\/api"/);
});

test('professional account pages and protected API routes exist',()=>{
 for(const page of ['apps/web/onboarding.html','apps/web/dashboard.html'])assert.match(read(page),/<title>/);
 const server=read('apps/api/src/server.ts');
 for(const route of ["app.get('/profile'","app.put('/profile'","app.get('/dashboard'"])assert.ok(server.includes(route),route);
});

test('account schema separates private identity and user capabilities',()=>{
 const schema=read('apps/api/prisma/schema.prisma');
 for(const field of ['email String? @unique','firstName String?','lastName String?','canRent Boolean','canHost Boolean','profileCompletedAt DateTime?'])assert.ok(schema.includes(field),field);
});

test('workspace catalogue uses one responsive five-column grid',()=>{
 const html=read('apps/web/workspaces.html');
 const css=read('apps/web/workspaces.css');
 const script=read('apps/web/workspaces.js');
 assert.match(html,/id="workspaceGrid"/);
 assert.match(css,/grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
 assert.match(css,/@media\(max-width:760px\)/);
 assert.match(script,/\/workspaces/);
 assert.doesNotMatch(html,/Que souhaitez-vous faire aujourd/);
 for(const page of ['apps/web/index.html','apps/web/publish.html','apps/web/demandes.html','apps/web/propositions.html'])assert.match(read(page),/href="workspaces\.html">Espaces de travail/);
});
