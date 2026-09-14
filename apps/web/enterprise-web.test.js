import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');

test('landing keeps the real marketplace runtime anchors', async () => {
  const html = await read('index.html');
  for (const id of ['listings', 'apiStatus', 'networkWarning', 'refresh', 'accountButton']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});

test('homepage critical path stays lean and marketplace loading is independent', async () => {
  const html = await read('index.html');
  const script = await read('app.js');
  assert.doesNotMatch(html, /vendor\/solana-web3\.min\.js/);
  assert.doesNotMatch(script, /window\.solana|encode58|connectedWallet/);
  assert.match(script, /Promise\.allSettled/);
  assert.match(script, /void loadMarketplace\(\);\s*void loadAccount\(\);/);
  assert.match(script, /AbortController/);
});

test('public copy never confuses signed Agent requests with Windows code signing', async () => {
  const files = await Promise.all(['index.html', 'trust.html', 'host-install.html'].map(read));
  const copy = files.join('\n');
  assert.doesNotMatch(copy, /Agent GPU signé/i);
  assert.match(copy, /Authenticode/i);
  assert.match(copy, /non signée|non signé|signature Windows/i);
});

test('trust center exposes verifiable release and environment concepts', async () => {
  const html = await read('trust.html');
  const script = await read('trust.js');
  assert.match(html, /SHA-256/);
  assert.match(html, /Devnet/);
  assert.match(html, /Mainnet/);
  assert.match(html, /qualification physique/i);
  assert.match(script, /fetchMetadata\('windows'\)/);
  assert.match(script, /jsonFetch\('\/health'\)/);
  assert.match(script, /AbortController/);
  assert.doesNotMatch(html, /certifi[ée]|production[- ]ready|100\s*%/i);
});

test('enterprise layer includes keyboard focus, skip link and reduced-motion handling', async () => {
  const css = await read('enterprise.css');
  assert.match(css, /\.skip-link/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});
