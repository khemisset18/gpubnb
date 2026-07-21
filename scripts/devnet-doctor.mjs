#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
let failures = 0;
const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
const fail = (m) => { failures += 1; console.log(`❌ ${m}`); };

function command(name, args=['--version'], required=true) {
  try {
    const out = execFileSync(name,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim().split('\n')[0];
    ok(`${name}: ${out}`);
  } catch {
    (required ? fail : warn)(`${name} introuvable`);
  }
}

console.log('GPUbnb — diagnostic Devnet\n');
command('node');
command('npm');
command('python3',['--version']);
command('docker',['--version'],false);
command('rustc',['--version'],false);
command('cargo',['--version'],false);
command('solana',['--version'],false);
command('anchor',['--version'],false);

for (const rel of ['apps/api/package.json','apps/api/prisma/schema.prisma','programs/gpu_escrow/src/lib.rs','apps/web/index.html','.env.example']) {
  existsSync(path.join(root,rel)) ? ok(rel) : fail(`${rel} absent`);
}

const envExample = readFileSync(path.join(root,'.env.example'),'utf8');
if (envExample.includes('ALLOW_MAINNET=false')) ok('Mainnet désactivé par défaut'); else fail('ALLOW_MAINNET=false absent');
if (envExample.includes('B5WQmXWHL8R86wf3LHLRE4aQAuRdRSz1EXKcwNQDqj2e')) ok('Portefeuille plateforme configuré'); else fail('Portefeuille plateforme absent');

console.log(`\nRésultat: ${failures === 0 ? 'base locale valide' : `${failures} erreur(s)`}.`);
console.log('Rust/Solana/Anchor sont facultatifs pour afficher le site, mais obligatoires pour compiler et déployer le contrat.');
process.exitCode = failures ? 1 : 0;
