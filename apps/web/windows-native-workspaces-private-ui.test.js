import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./workspaces.js', import.meta.url), 'utf8');

const fixture = Object.freeze([
  { slug: 'cloud-desktop', name: 'Cloud Desktop', summary: 'Bureau distant', icon: '🖥️', release: 'UPCOMING', category: 'CREATION', technologies: ['Windows'], license: 'MIXED' },
  { slug: 'creator', name: 'Creator', summary: 'Blender', icon: '🎨', release: 'UPCOMING', category: 'CREATION', technologies: ['Blender'], license: 'INCLUDED_OPEN_SOURCE' },
  { slug: 'cad', name: 'CAD', summary: 'FreeCAD', icon: '📐', release: 'UPCOMING', category: 'CAD', technologies: ['FreeCAD'], license: 'INCLUDED_OPEN_SOURCE' },
  { slug: 'gaming', name: 'Gaming', summary: 'Steam', icon: '🎮', release: 'UPCOMING', category: 'GAMING', technologies: ['Steam'], license: 'USER_ACCOUNT_REQUIRED' },
]);

function element(tag) {
  return {
    tagName: tag.toUpperCase(),
    dataset: {},
    children: [],
    disabled: false,
    textContent: '',
    innerHTML: '',
    append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
  };
}

async function openCatalogue({ authorized = true, ownerAuthorized = true, machineContext = true, preflight, httpStatus = 200, workspaces = fixture } = {}) {
  const grid = element('section');
  const panel = { hidden: true };
  const ownerTools = { hidden: true, style: {} };
  const ownerMessage = element('span');
  const analyzeButton = { addEventListener() {} };
  const count = element('p');
  const calls = [];
  const document = {
    querySelector(selector) {
      if (selector === '#workspaceGrid') return grid;
      if (selector === '#resultCount') return count;
      if (selector === '#privateWindowsQualification') return panel;
      if (selector === '#ownerTools') return ownerTools;
      if (selector === '#ownerMessage') return ownerMessage;
      if (selector === '#analyzeButton') return analyzeButton;
      throw new Error('Unexpected selector: ' + selector);
    },
    querySelectorAll(selector) {
      if (selector === '[data-filter]') return [];
      throw new Error('Unexpected selector: ' + selector);
    },
    createElement: element,
  };

  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', credentials: options.credentials });
    if (path === '/workspaces') return { ok: true, status: 200, json: async () => ({ workspaces }) };
    if (path.startsWith('/machines/') && path.endsWith('/workspaces/manage')) return authorized && ownerAuthorized
      ? { ok: true, status: 200, json: async () => ({ workspaces: [] }) }
      : { ok: false, status: 404, json: async () => ({ error: 'machine_not_found' }) };
    if (path === '/auth/me') return authorized
      ? { ok: true, status: 200, json: async () => ({ user: { id: 'authorized-owner' } }) }
      : { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
    if (path === '/qualification/windows-native/preflight') return {
      ok: httpStatus === 200,
      status: httpStatus,
      json: async () => preflight ?? { error: 'not_found' },
    };
    throw new Error('Unexpected API request: ' + path);
  };

  vm.runInNewContext(source, {
    document,
    fetch,
    window: { GPUBNB_CONFIG: { apiBase: 'https://private.example.invalid' } },
    location: { search: machineContext ? '?machine=cmsiggruy0004df0tn669f6bn' : '' },
    URLSearchParams,
  }, { filename: 'workspaces.js' });
  await new Promise(resolve => setTimeout(resolve, 20));
  return { grid, panel, count, calls };
}

const allowed = {
  privateNoPaymentMode: true,
  allowed: true,
  code: 'PRIVATE_WINDOWS_TEST_ATTEMPT_ALLOWED',
};

test('Cloud Desktop receives a private link only after authenticated positive read-only preflight', async () => {
  const view = await openCatalogue({ preflight: allowed });
  assert.equal(view.panel.hidden, false);
  assert.equal(view.grid.children.length, 4);
  assert.equal(view.grid.children[0].children[0].tagName, 'A');
  assert.equal(view.grid.children[0].children[0].href, 'stage3-windows-native.html');
  for (const card of view.grid.children.slice(1)) {
    assert.equal(card.children[0].tagName, 'BUTTON');
    assert.equal(card.children[0].disabled, true);
  }
  assert.deepEqual(view.calls.map(call => call.path), [
    '/workspaces', '/machines/cmsiggruy0004df0tn669f6bn/workspaces/manage', '/auth/me', '/qualification/windows-native/preflight',
  ]);
  assert.ok(view.calls.every(call => call.credentials === 'include' && call.method === 'GET'));
});

test('fail closed on denied, incomplete, wrong-mode or wrong-code preflight', async () => {
  for (const preflight of [
    { ...allowed, allowed: false },
    { ...allowed, privateNoPaymentMode: false },
    { ...allowed, code: 'UNEXPECTED' },
    { allowed: true, code: allowed.code },
  ]) {
    const view = await openCatalogue({ preflight });
    assert.equal(view.panel.hidden, true);
    assert.equal(view.grid.children[0].children[0].tagName, 'BUTTON');
    assert.equal(view.grid.children[0].children[0].disabled, true);
  }
  const unavailable = await openCatalogue({ httpStatus: 404 });
  assert.equal(unavailable.panel.hidden, true);
});

test('unauthenticated browsers do not query the private preflight or receive a private link', async () => {
  const view = await openCatalogue({ authorized: false, preflight: allowed });
  assert.equal(view.panel.hidden, true);
  assert.equal(view.calls.some(call => call.path.endsWith('/preflight')), false);
  assert.equal(view.grid.children[0].children[0].tagName, 'BUTTON');
});

test('workspace manifest HTML is escaped rather than interpreted as markup', async () => {
  const workspaces = [{ ...fixture[0], name: '<img src=x onerror=alert(1)>', summary: '<script>alert(1)</script>', technologies: ['<svg onload=alert(1)>'] }];
  const view = await openCatalogue({ workspaces, preflight: allowed });
  const html = view.grid.children[0].innerHTML;
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;svg'));
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img '), false);
  assert.equal(html.includes('<svg '), false);
});

test('public catalogue and foreign machine cannot expose a private test', async () => {
  const noMachine = await openCatalogue({ preflight: allowed, machineContext: false });
  assert.equal(noMachine.panel.hidden, true);
  assert.equal(noMachine.calls.some(call => call.path.endsWith('/preflight')), false);
  assert.equal(noMachine.grid.children[0].children[0].tagName, 'BUTTON');

  const foreignOwner = await openCatalogue({ preflight: allowed, ownerAuthorized: false });
  assert.equal(foreignOwner.panel.hidden, true);
  assert.equal(foreignOwner.calls.some(call => call.path.endsWith('/preflight')), false);
  assert.equal(foreignOwner.grid.children[0].children[0].tagName, 'BUTTON');
});
