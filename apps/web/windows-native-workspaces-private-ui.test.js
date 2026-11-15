import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// This page is a catalogue, never an authority to capture an existing PC1 desktop.
const source = readFileSync(new URL('./workspaces.js', import.meta.url), 'utf8');
const markup = readFileSync(new URL('./workspaces.html', import.meta.url), 'utf8');

const fixture = [
  { slug: 'cloud-desktop', name: 'Cloud Desktop', summary: 'Bureau GPU', icon: '🖥️', release: 'UPCOMING', category: 'DESKTOP', technologies: ['Selkies'], license: 'INCLUDED_OPEN_SOURCE' },
  { slug: 'creator', name: 'Creator', summary: 'Blender GPU', icon: '🎨', release: 'UPCOMING', category: 'CREATION', technologies: ['Blender'], license: 'INCLUDED_OPEN_SOURCE' },
  { slug: 'cad', name: 'CAD', summary: 'FreeCAD', icon: '📐', release: 'UPCOMING', category: 'CAD', technologies: ['FreeCAD'], license: 'INCLUDED_OPEN_SOURCE' },
  { slug: 'gaming', name: 'Gaming', summary: 'Steam isolé', icon: '🎮', release: 'UPCOMING', category: 'GAMING', technologies: ['Steam'], license: 'USER_ACCOUNT_REQUIRED' },
  { slug: 'compute', name: 'Compute', summary: 'Tâches', icon: '⚡', release: 'BETA', category: 'COMPUTE', technologies: ['CUDA'], license: 'MIXED' },
];

function el(tag = 'div') {
  const events = new Map();
  return {
    tagName: tag.toUpperCase(), events, dataset: {}, children: [], hidden: false,
    style: {}, textContent: '', innerHTML: '', disabled: false,
    addEventListener(name, fn) { events.set(name, fn); },
    append(item) { this.children.push(item); },
    replaceChildren(...items) { this.children = items; },
    scrollIntoView() {},
  };
}

async function openCatalogue({ machineContext = false, ownerAuthorized = true, workspaces = fixture, analyses = [] } = {}) {
  const elements = Object.fromEntries([
    '#workspaceGrid', '#resultCount', '#ownerTools', '#analyzeButton',
    '#ownerMessage', '#workspaceSelection', '#selectedWorkspaceName',
    '#selectedWorkspaceStatus', '#selectedWorkspaceExplanation',
  ].map(key => [key, el()]));
  elements['#workspaceSelection'].hidden = true;
  const paths = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    paths.push({ path, method: options.method || 'GET' });
    if (path === '/workspaces') return { ok: true, status: 200, json: async () => ({ workspaces }) };
    if (path.endsWith('/workspaces/manage')) {
      return ownerAuthorized
        ? { ok: true, status: 200, json: async () => ({ workspaces: analyses }) }
        : { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
    }
    throw Error('Unexpected service call: ' + path);
  };
  const document = {
    querySelector(s) {
      if (!(s in elements)) throw Error('Unexpected selector ' + s);
      return elements[s];
    },
    querySelectorAll(selector) {
      if (selector === '[data-filter]') return [];
      throw Error('Unexpected selector ' + selector);
    },
    createElement: el,
  };
  vm.runInNewContext(source, {
    document, fetch,
    window: { GPUBNB_CONFIG: { apiBase: 'https://private.example.invalid' } },
    location: { search: machineContext ? '?machine=cmsiggruy0004df0tn669f6bn' : '' },
    URLSearchParams,
  }, { filename: 'workspaces.js' });
  await new Promise(resolve => setTimeout(resolve, 20));
  return { elements, paths };
}

test('four graphical workspaces can be selected for diagnosis with no booking or desktop opening', async () => {
  const view = await openCatalogue();
  const cards = view.elements['#workspaceGrid'].children;
  assert.equal(cards.length, fixture.length);
  for (let i = 0; i < 4; i++) {
    const button = cards[i].children[0];
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Sélectionner pour diagnostic');
    button.events.get('click')();
    assert.equal(view.elements['#workspaceSelection'].hidden, false);
    assert.equal(view.elements['#selectedWorkspaceName'].textContent, fixture[i].name);
    assert.match(view.elements['#selectedWorkspaceStatus'].textContent, /aucun bureau virtuel GPU isolé/);
  }
  assert.equal(cards[4].children[0].disabled, true);
  assert.deepEqual(view.paths.map(x => x.path), ['/workspaces']);
  assert.ok(view.paths.every(call => call.method === 'GET'));
});

test('even an owner-visible GPU does not bypass the virtual desktop runtime requirement', async () => {
  const view = await openCatalogue({ machineContext: true, analyses: [
    { workspace: { slug: 'gaming' }, state: 'READY', analysis: { missing: ['DRM GPU graphics not verified'] } },
  ] });
  const gaming = view.elements['#workspaceGrid'].children[3];
  gaming.children[0].events.get('click')();
  assert.match(view.elements['#selectedWorkspaceExplanation'].textContent, /DRM GPU graphics not verified/);
  assert.equal(view.paths.length, 2);
  assert.ok(view.paths.every(call => call.method === 'GET'));
});

test('refused owner lookup does not cause a private console fallback', async () => {
  const view = await openCatalogue({ machineContext: true, ownerAuthorized: false });
  view.elements['#workspaceGrid'].children[3].children[0].events.get('click')();
  assert.equal(view.elements['#workspaceSelection'].hidden, false);
  assert.deepEqual(view.paths.map(c => c.path), [
    '/workspaces', '/machines/cmsiggruy0004df0tn669f6bn/workspaces/manage',
  ]);
  assert.doesNotMatch(source, /stage3-windows-native\.html|qualification\/windows-native\/preflight/);
  assert.doesNotMatch(markup, /stage3-windows-native\.html|id="privateWindowsQualification"/);
});

test('malicious manifest strings are escaped in workspace cards and not interpreted', async () => {
  const malicious = { ...fixture[0], name: '<img src=x onerror=alert(1)>', summary: '<script>alert(1)</script>', technologies: ['<svg onload=alert(1)>'] };
  const view = await openCatalogue({ workspaces: [malicious] });
  const html = view.elements['#workspaceGrid'].children[0].innerHTML;
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;svg'));
  assert.doesNotMatch(html, /<img |<script>|<svg /);
});

test('selection does not silently convert graphical workspaces into a Beta product', async () => {
  const view = await openCatalogue();
  const cards = view.elements['#workspaceGrid'].children;
  for (const card of cards.slice(0, 4)) assert.equal(card.dataset.release, 'UPCOMING');
  assert.doesNotMatch(markup, /Ouvrir le test Windows privé/);
  assert.match(markup, /créé et contrôlé pour chaque réservation/);
});
