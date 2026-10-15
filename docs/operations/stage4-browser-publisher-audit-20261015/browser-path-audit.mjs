// Isolated audit of the existing browser sources, not a product acceptance suite.
// Every fetch is simulated. No browser, account, booking, key or device is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRoot = process.argv[2] ? resolve(process.argv[2]) : root;
const sourceCommit = process.argv[2] ? (process.argv[3] ?? null) : 'd21af2fbf1f110dff5c0cab7a460035fb2ddefa6';
const files = {};
function source(path) {
  const text = readFileSync(resolve(sourceRoot, path), 'utf8');
  files[path] = createHash('sha256').update(text).digest('hex');
  return text;
}
function sandbox(fetchFn, search = '') {
  const events = new Map();
  const nodes = new Map();
  const document = {
    addEventListener() {},
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, {
        style: {}, hidden: false, textContent: '', disabled: false,
        replaceChildren() {},
        addEventListener(name, fn) { events.set(`${selector}:${name}`, fn); },
      });
      return nodes.get(selector);
    },
  };
  const location = {
    origin: 'https://audit.invalid', pathname: '/dashboard.html', search,
    href: 'https://audit.invalid/dashboard.html',
    assign(value) { this.assigned = value; },
  };
  const window = { location, addEventListener() {} };
  const context = vm.createContext({
    document, window, location, URL, URLSearchParams, TextEncoder, console,
    fetch: fetchFn, prompt: () => '5',
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    clearInterval() {},
  });
  return { context, events, nodes, location, window };
}
function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
function pathOf(url) {
  const u = new URL(url, 'https://audit.invalid');
  return u.pathname + u.search;
}
const observations = [];
const chooseSource = source('apps/web/choose-workspace.js');

// A valid ordinary Web session does not require window.solana or an extension.
{
  const calls = [];
  const box = sandbox(async (url, options = {}) => {
    const path = pathOf(url); calls.push({ method: options.method ?? 'GET', path });
    if (path === '/auth/me') return response(200, { user: { id: 'audit-user' } });
    if (path === '/bookings') return response(200, { id: 'audit-booking' });
    if (path === '/bookings/audit-booking/workspace/developer') return response(200, {});
    throw new Error(`unexpected_mock_request:${path}`);
  });
  vm.runInContext(chooseSource, box.context);
  await vm.runInContext("prepareSelected({id:'audit-listing'}, {slug:'developer',name:'Developer',compatible:true,bookable:true}, {disabled:false,textContent:''})", box.context);
  assert.equal(box.location.href, 'bookings.html');
  assert.equal(calls.length, 3);
  assert.equal(box.window.solana, undefined);
  observations.push({ case: 'existing_web_session_without_wallet', observed: 'frontend_booking_and_preparation_succeed', browserOnlyCompatible: true, calls });
}

// Record the actual gap: any /auth/me error falls back to Phantom, even 500.
for (const status of [401, 500]) {
  const calls = [];
  const box = sandbox(async (url) => {
    calls.push(pathOf(url));
    return response(status, { error: status === 401 ? 'authentication_required' : 'internal_error' });
  });
  vm.runInContext(chooseSource, box.context);
  await assert.rejects(vm.runInContext('authenticate()', box.context), /installez Phantom/);
  assert.equal(calls.length, 1);
  assert.equal(box.location.assigned, undefined);
  observations.push({ case: `missing_or_failed_web_session_${status}`, observed: 'phantom_installation_offer_instead_of_web_login_or_service_error', browserOnlyCompatible: false, liveMutationPerformed: false });
}

// Exercise the real dashboard decision function, without executing DOM startup.
{
  const box = sandbox(() => { throw new Error('network_forbidden'); });
  vm.runInContext(source('apps/web/portal.js'), box.context);
  box.context.auditData = { user: { needsOnboarding: false, canRent: true, canHost: false }, host: { machines: [], listings: [] }, tenant: { bookings: [] } };
  const action = vm.runInContext('nextStep(auditData)', box.context);
  assert.equal(action[0], 'Activer l’espace propriétaire');
  observations.push({ case: 'renter_only_dashboard', observed: action[0], destination: action[2], browserOnlyCompatible: false, severity: 'misleading_navigation_not_backend_installation_requirement' });
  box.context.auditData.user.canHost = true;
  const dual = vm.runInContext('nextStep(auditData)', box.context);
  assert.equal(dual[2], 'host-install.html');
  observations.push({ case: 'dual_role_account_without_host', observed: dual[0], destination: dual[2], severity: 'host_priority_in_dashboard_not_a_client_dependency' });
}

// The login allowlist drops a selected listing; do not weaken its redirect guard.
{
  const box = sandbox(() => { throw new Error('network_forbidden'); }, '?next=' + encodeURIComponent('choose-workspace.html?listing=audit-listing'));
  vm.runInContext(source('apps/web/auth.js'), box.context);
  const destination = vm.runInContext('safeNext()', box.context);
  assert.equal(destination, 'dashboard.html');
  observations.push({ case: 'return_to_selected_workspace_after_login', observed: destination, browserOnlyCompatible: true, preservesBookingIntent: false });
}

// Full private-page orchestration, with simulated API guards already satisfied.
// This does NOT assert that the server flag, funding or Host is ready in reality.
{
  const calls = [];
  const replies = new Map([
    ['/auth/me', { user: { id: 'audit-user' } }],
    ['/qualification/windows-native/booking', { bookingId: 'audit-booking' }],
    ['/dashboard', { tenant: { bookings: [{ id: 'audit-booking', status: 'FUNDED' }] } }],
    ['/bookings/audit-booking/workspace/cloud-desktop?qualification=windows-native', {}],
    ['/bookings/audit-booking/workspace/cloud-desktop/status', { status: 'READY', canOpen: true }],
    ['/bookings/audit-booking/workspace/cloud-desktop/access', { openPath: '/workspace-gateway/audit-session' }],
  ]);
  const box = sandbox(async (url, options = {}) => {
    const path = pathOf(url); calls.push({ method: options.method ?? 'GET', path });
    assert.equal(replies.has(path), true, `unexpected mock request: ${path}`);
    return response(200, replies.get(path));
  });
  vm.runInContext(source('apps/web/stage3-windows-native.js'), box.context);
  box.events.get('#stage3-start:click')();
  for (let turn = 0; turn < 100 && !box.location.assigned; turn++) await Promise.resolve();
  assert.equal(box.location.assigned, '/workspace-gateway/audit-session');
  assert.equal(box.window.solana, undefined);
  assert.equal(calls.length, 6);
  observations.push({ case: 'private_qualification_page_without_wallet', observed: 'access_path_opened_after_all_simulated_guards', browserOnlyCompatible: true, calls });
}

console.log(JSON.stringify({
  schemaVersion: 1, collectedAtUtc: new Date().toISOString(),
  mode: 'NODE_VM_SOURCE_AUDIT_SIMULATED_HTTP_ONLY',
  sourceCommit,
  sourceRootKind: process.argv[2] ? 'delivered_public_javascript_snapshot' : 'repository_checkout',
  sourceFilesSha256: files, observations,
  actualBrowserLoginPerformed: false, actualBookingOrSessionCreated: false,
  pc1OrPc2Accessed: false, privateKeyAccessed: false, signingPerformed: false,
  standardCiReexecuted: false, tlsProviderTestsReexecuted: false,
  conclusion: 'AUDIT_REPRODUCED_GAPS_NOT_A_PHYSICAL_OR_AUTHENTICATION_ACCEPTANCE',
}, null, 2));
