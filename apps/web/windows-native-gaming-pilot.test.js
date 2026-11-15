import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./stage4-gaming-visual-pilot.js', import.meta.url), 'utf8');

const MACHINE = 'cmsiggruy0004df0tn669f6bn';
const ALLOWED = {
  privateNoPaymentMode: true,
  allowed: true,
  code: 'PRIVATE_WINDOWS_TEST_ATTEMPT_ALLOWED',
};

async function simulate({
  query = '?machine=' + MACHINE,
  authenticated = true,
  owner = true,
  validOwnerPayload = true,
  preflight = ALLOWED,
  preflightHttp = 200,
} = {}) {
  const status = { textContent: 'Vérification…' };
  const continueLink = { hidden: true, href: 'stage3-windows-native.html' };
  const calls = [];
  const fetch = async (url, opts) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, opts });
    if (u.pathname === '/auth/me') return authenticated
      ? { ok: true, json: async () => ({ user: { id: 'owner' } }) }
      : { ok: false, json: async () => ({ error: 'unauthorized' }) };
    if (u.pathname === '/machines/' + MACHINE + '/workspaces/manage') return owner
      ? { ok: true, json: async () => validOwnerPayload ? { workspaces: [] } : { noWorkspaces: true } }
      : { ok: false, json: async () => ({ error: 'not_found' }) };
    if (u.pathname === '/qualification/windows-native/preflight') return {
      ok: preflightHttp === 200,
      json: async () => preflight,
    };
    throw new Error('Unexpected URL: ' + url);
  };
  vm.runInNewContext(source, {
    window: { GPUBNB_CONFIG: { apiBase: 'https://private.example.invalid' } },
    document: {
      querySelector(selector) {
        if (selector === '#gamingPilotStatus') return status;
        if (selector === '#gamingPilotContinue') return continueLink;
        throw Error('Unexpected selector: ' + selector);
      },
    },
    location: { search: query },
    URLSearchParams,
    fetch,
  }, { filename: 'stage4-gaming-visual-pilot.js' });
  await new Promise(resolve => setTimeout(resolve, 20));
  return { status, continueLink, calls };
}

test('requires exact owner, auth and private readiness; no booking is created on page load', async () => {
  const view = await simulate();
  assert.equal(view.continueLink.hidden, false);
  assert.equal(view.continueLink.href, 'stage3-windows-native.html');
  assert.deepEqual(view.calls.map(c => c.path), [
    '/auth/me',
    '/machines/' + MACHINE + '/workspaces/manage',
    '/qualification/windows-native/preflight',
  ]);
  for (const call of view.calls) {
    assert.equal(call.opts.method, 'GET');
    assert.equal(call.opts.credentials, 'include');
    assert.equal(call.opts.cache, 'no-store');
    assert.equal(call.opts.headers.accept, 'application/json');
  }
});

test('absent or malformed machine identifier fails closed without contacting server', async () => {
  for (const query of ['', '?machine=../../a', '?machine=wrong', '?machine=https://other']) {
    const view = await simulate({ query });
    assert.equal(view.continueLink.hidden, true);
    assert.equal(view.calls.length, 0);
  }
});

test('other users, session expiration and missing owner proof cannot see private launch', async () => {
  for (const options of [
    { authenticated: false },
    { owner: false },
    { validOwnerPayload: false },
  ]) {
    const view = await simulate(options);
    assert.equal(view.continueLink.hidden, true);
    assert.equal(view.calls.some(call => call.path.endsWith('/preflight')), false);
  }
});

test('wrong preflight code, other billing mode and server errors fail closed', async () => {
  for (const options of [
    { preflight: { ...ALLOWED, allowed: false } },
    { preflight: { ...ALLOWED, privateNoPaymentMode: false } },
    { preflight: { ...ALLOWED, code: 'OTHER_CODE' } },
    { preflight: {} },
    { preflightHttp: 404 },
  ]) {
    const view = await simulate(options);
    assert.equal(view.continueLink.hidden, true);
  }
});

test('Gaming page remains only a manual pilot, with no standalone Gaming or Steam launch', () => {
  const html = readFileSync(new URL('./stage4-gaming-visual-pilot.html', import.meta.url), 'utf8');
  assert.match(html, /n'active pas le workspace Gaming officiel/);
  assert.match(html, /pas de démarrage automatique/);
  assert.match(html, /non qualifi/);
  assert.match(html, /stage3-windows-native\.html/);
  assert.doesNotMatch(source, /method:\s*['"]POST['"]/);
  assert.doesNotMatch(source, /\/workspace\/gaming/);
});

test('the private action stays CSS-hidden until a positive authorization', () => {
  const css = readFileSync(new URL('./portal.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./stage4-gaming-visual-pilot.html', import.meta.url), 'utf8');
  assert.match(html, /id="gamingPilotContinue"[^>]*hidden/);
  assert.match(css, /\.button\[hidden\]\s*\{\s*display:\s*none\s*\}/);
});
