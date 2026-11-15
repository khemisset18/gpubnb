import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('./choose-workspace.js', import.meta.url), 'utf8');
const markup = readFileSync(new URL('./choose-workspace.html', import.meta.url), 'utf8');
const slugs = ['cloud-desktop', 'creator', 'cad', 'gaming'];
const workspace = slug => ({
  slug, icon: '🎮', name: slug, summary: 'Workspace graphique isolé',
  technologies: ['Selkies'], release: 'UPCOMING', compatible: false,
  bookable: false, compatibility: { state: 'INCOMPATIBLE', score: 0, missing: ['GPU virtuel non qualifié'] },
});

function node() {
  const events = new Map();
  return {
    events, children: [], textContent: '', innerHTML: '', hidden: false,
    dataset: {}, className: '', disabled: false,
    append(...els) { this.children.push(...els); },
    replaceChildren(...els) { this.children = els; },
    addEventListener(name, handler) { events.set(name, handler); },
    setAttribute() {},
    scrollIntoView() {},
  };
}

async function load({ items = slugs.map(workspace), selected = null } = {}) {
  const listing = {
    title: 'GPU test privé', gpu: { vendor: 'NVIDIA', model: 'GPU test', vramMiB: 4096 },
    workspaces: items,
  };
  const nodes = new Map();
  const calls = [];
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, node());
      return nodes.get(selector);
    },
    createElement: () => node(),
  };
  const fetch = async (url, options = {}) => {
    const path = new URL(url, 'https://test.invalid').pathname;
    calls.push({ path, method: options.method || 'GET' });
    if (path === '/rental/listings/own-gpu/workspace-catalogue') return {
      ok: true, status: 200, json: async () => listing,
    };
    throw Error('Unexpected endpoint ' + path);
  };
  const search = '?listing=own-gpu' + (selected ? '&workspace=' + selected : '');
  vm.runInNewContext(script, {
    window: { GPUBNB_API_URL: 'https://test.invalid' },
    document, location: { search }, URLSearchParams, fetch,
  }, { filename: 'choose-workspace.js' });
  await new Promise(resolve => setTimeout(resolve, 20));
  return { nodes, calls };
}

test('all four graphical modules are selectable from the marketplace without a booking', async () => {
  const view = await load();
  const cards = view.nodes.get('#workspaceCatalogue').children;
  assert.equal(cards.length, 4);
  assert.equal(view.nodes.get('#workspaceChoices').children.length, 0);
  for (let index = 0; index < 4; index++) {
    const selectionButton = cards[index].children[0];
    assert.equal(selectionButton.type, 'button');
    assert.equal(selectionButton.textContent, 'Sélectionner pour test');
    selectionButton.events.get('click')();
    assert.equal(view.nodes.get('#workspaceDiagnostic').hidden, false);
    assert.equal(view.nodes.get('#workspaceDiagnosticTitle').textContent, slugs[index]);
    assert.match(view.nodes.get('#workspaceDiagnosticStatus').textContent, /Lancement réel indisponible/);
  }
  assert.deepEqual(view.calls.map(call => call.path), [
    '/rental/listings/own-gpu/workspace-catalogue',
    '/rental/listings/own-gpu/workspace-catalogue',
  ]);
  assert.ok(view.calls.every(call => call.method === 'GET'));
});

test('URL workspace selection is restored without creating a reservation', async () => {
  const view = await load({ selected: 'gaming' });
  assert.equal(view.nodes.get('#workspaceDiagnostic').hidden, false);
  assert.equal(view.nodes.get('#workspaceDiagnosticTitle').textContent, 'gaming');
  assert.ok(view.calls.every(call => call.method === 'GET'));
});

test('only server-bookable compatible workspaces enter the existing booking chooser', async () => {
  const items = [
    { ...workspace('gaming'), compatible: true, bookable: false,
      compatibility: { state: 'READY', score: 100, missing: [] } },
    { ...workspace('compute'), release: 'BETA', compatible: true, bookable: true,
      compatibility: { state: 'READY', score: 100, missing: [] } },
  ];
  const view = await load({ items });
  const chosen = view.nodes.get('#workspaceChoices').children;
  assert.equal(chosen.length, 1);
  assert.match(chosen[0].innerHTML, /compute/);
  assert.equal(view.nodes.get('#workspaceCatalogue').children[0].children[0].textContent, 'Sélectionner pour test');
  view.nodes.get('#workspaceCatalogue').children[0].children[0].events.get('click')();
  assert.match(view.nodes.get('#workspaceDiagnosticStatus').textContent, /Lancement réel indisponible/);
  assert.ok(view.calls.every(call => call.method === 'GET'));
});

test('workspace names, summaries, requirements and technologies cannot inject markup', async () => {
  const unsafe = { ...workspace('gaming'),
    name: '<img src=x onerror=alert(1)>', summary: '<script>alert(1)</script>',
    technologies: ['<svg onload=alert(1)>'],
    compatibility: { state: 'INCOMPATIBLE', score: 0, missing: ['<iframe src=x>'] },
  };
  const view = await load({ items: [unsafe] });
  const html = view.nodes.get('#workspaceCatalogue').children[0].innerHTML;
  for (const expected of ['&lt;img', '&lt;script', '&lt;svg', '&lt;iframe'])
    assert.ok(html.includes(expected), 'missing escaped value ' + expected);
  assert.doesNotMatch(html, /<script|<img |<svg |<iframe/);
});

test('a selected graphics workspace is never silently redirected to the existing Windows console', () => {
  assert.doesNotMatch(script, /stage3-windows-native|qualification\/windows-native\/booking/);
  assert.match(script, /if\(!workspace.compatible\|\|!workspace.bookable\)/);
  assert.match(markup, /ne peut jamais ouvrir un compte Windows/);
  assert.match(readFileSync(new URL('./styles.css', import.meta.url), 'utf8'),
    /\.workspace-diagnostic\[hidden\]\s*\{\s*display:none\s*\}/);
});
