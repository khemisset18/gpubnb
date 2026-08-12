import fs from 'node:fs';

const [debugOrigin, targetUrl, domPath] = process.argv.slice(2);
if (!debugOrigin || !targetUrl || !domPath) {
  console.error('usage: browser-smoke-test.mjs <debug-origin> <target-url> <dom-path>');
  process.exit(2);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let targets;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const response = await fetch(`${debugOrigin}/json/list`);
    if (response.ok) {
      targets = await response.json();
      if (Array.isArray(targets) && targets.some(target => target.type === 'page')) break;
    }
  } catch {}
  await sleep(100);
}

const page = Array.isArray(targets) ? targets.find(target => target.type === 'page') : null;
if (!page?.webSocketDebuggerUrl) {
  console.error('cdp_page_target_unavailable');
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
const diagnostics = [];
const scriptResponses = [];
const failedResponses = [];
const loadingFailures = [];
const websocketEvents = [];

const record = (kind, detail) => {
  diagnostics.push({ kind, detail });
};

socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result ?? {});
    }
    return;
  }

  const { method, params = {} } = message;
  if (method === 'Runtime.exceptionThrown') {
    const exception = params.exceptionDetails ?? {};
    record('exception', {
      text: exception.text,
      url: exception.url,
      lineNumber: exception.lineNumber,
      columnNumber: exception.columnNumber,
      description: exception.exception?.description,
    });
  } else if (method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(params.type)) {
    record(`console-${params.type}`, (params.args ?? []).map(arg => arg.value ?? arg.description ?? arg.type));
  } else if (method === 'Log.entryAdded') {
    const entry = params.entry ?? {};
    if (entry.level === 'error' || entry.level === 'warning') {
      record(`browser-${entry.level}`, {
        source: entry.source,
        text: entry.text,
        url: entry.url,
        lineNumber: entry.lineNumber,
      });
    }
  } else if (method === 'Network.responseReceived') {
    const response = params.response ?? {};
    const row = {
      type: params.type,
      status: response.status,
      mimeType: response.mimeType,
      url: response.url,
    };
    if (params.type === 'Script') scriptResponses.push(row);
    if (Number(response.status) >= 400) failedResponses.push(row);
  } else if (method === 'Network.loadingFailed') {
    loadingFailures.push({
      type: params.type,
      errorText: params.errorText,
      blockedReason: params.blockedReason,
      canceled: params.canceled,
    });
  } else if (method === 'Network.webSocketCreated') {
    websocketEvents.push({ event: 'created', url: params.url });
  } else if (method === 'Network.webSocketHandshakeResponseReceived') {
    websocketEvents.push({ event: 'handshake', status: params.response?.status, url: params.response?.url });
  } else if (method === 'Network.webSocketClosed') {
    websocketEvents.push({ event: 'closed', timestamp: params.timestamp });
  }
});

const opened = new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('cdp_websocket_open_failed')), { once: true });
});
await opened;

const send = (method, params = {}) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
};

await Promise.all([
  send('Runtime.enable'),
  send('Log.enable'),
  send('Network.enable'),
  send('Page.enable'),
]);

await send('Page.navigate', { url: targetUrl });
await sleep(15_000);

const stateResult = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    readyState: document.readyState,
    title: document.title,
    href: location.href,
    bodyChildren: document.body ? document.body.children.length : -1,
    monaco: Boolean(document.querySelector('.monaco-workbench, .monaco-grid-view, .part.editor')),
    text: (document.body?.innerText || '').slice(0, 1000),
    html: document.documentElement?.outerHTML || ''
  })`,
  returnByValue: true,
});
const serializedState = stateResult.result?.value;
const state = typeof serializedState === 'string' ? JSON.parse(serializedState) : {};
fs.writeFileSync(domPath, state.html ?? '', 'utf8');
delete state.html;

const suspiciousScripts = scriptResponses.filter(row => {
  const mime = String(row.mimeType || '').toLowerCase();
  return Number(row.status) >= 400 || (!mime.includes('javascript') && !mime.includes('ecmascript') && !mime.includes('wasm'));
});

const criticalStaticFailures = failedResponses.filter(row => {
  const url = String(row.url || '');
  if (!/\/stable-[^/]+\/static\//.test(url)) return false;
  return row.type === 'Script' || /\.(?:js|mjs|wasm|css)(?:[?#]|$)/i.test(url);
});

const criticalLoadingFailures = loadingFailures.filter(row => {
  if (row.canceled) return false;
  return ['Script', 'Stylesheet', 'WebSocket', 'Fetch', 'XHR'].includes(String(row.type || ''));
});

const handshakes = websocketEvents.filter(row => row.event === 'handshake');
const badHandshakes = handshakes.filter(row => Number(row.status) !== 101);

console.error('browser_state=' + JSON.stringify(state));
console.error('script_responses=' + JSON.stringify(scriptResponses));
console.error('suspicious_scripts=' + JSON.stringify(suspiciousScripts));
console.error('failed_responses=' + JSON.stringify(failedResponses));
console.error('critical_static_failures=' + JSON.stringify(criticalStaticFailures));
console.error('loading_failures=' + JSON.stringify(loadingFailures));
console.error('critical_loading_failures=' + JSON.stringify(criticalLoadingFailures));
console.error('websocket_events=' + JSON.stringify(websocketEvents));
console.error('browser_diagnostics=' + JSON.stringify(diagnostics));

socket.close();

if (!state.monaco) {
  console.error('developer_workbench_monaco_not_rendered');
  process.exit(1);
}
if (criticalStaticFailures.length > 0) {
  console.error('developer_workbench_critical_static_asset_failed');
  process.exit(1);
}
if (suspiciousScripts.length > 0) {
  console.error('developer_workbench_script_status_or_mime_invalid');
  process.exit(1);
}
if (criticalLoadingFailures.length > 0) {
  console.error('developer_workbench_critical_network_load_failed');
  process.exit(1);
}
if (badHandshakes.length > 0) {
  console.error('developer_workbench_websocket_handshake_failed');
  process.exit(1);
}
// A healthy remote workbench establishes at least the Management and
// ExtensionHost WebSockets. Requiring two successful handshakes prevents the
// historical false-positive where Monaco rendered but the page remained unusable.
if (handshakes.length < 2) {
  console.error(`developer_workbench_missing_remote_websockets:${handshakes.length}`);
  process.exit(1);
}
