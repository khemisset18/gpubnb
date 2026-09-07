from pathlib import Path

p = Path('e2e/run.cjs')
s = p.read_text()

if "const { randomUUID } = require('crypto');" not in s:
    marker = "const { execFileSync, spawnSync } = require('child_process');\n"
    if s.count(marker) != 1:
        raise SystemExit(f'crypto import marker count={s.count(marker)}')
    s = s.replace(marker, marker + "const { randomUUID } = require('crypto');\n", 1)

old = '''  await new Promise((resolve, reject) => {
    // The gateway's upgrade handler (workspace-gateway.ts) matches
    // /workspace-gateway/:sessionId/<upstream-path-to-proxy> - a bare
    // /workspace-gateway/:sessionId with nothing after it 404s
    // (websocket_route_not_found), same as a real browser's very first
    // WebSocket request to code-server's own root path would look like.
    const [pathAndQuery] = grant.openPath.split('?');
    const url = `${API.replace('http', 'ws')}${pathAndQuery}/`;
    const ws = new WebSocket(url, { headers: { cookie: gatewayCookie } });
    const timer = setTimeout(() => reject(new Error('activation websocket did not open in time')), 15_000);
    ws.on('open', () => { clearTimeout(timer); setTimeout(() => ws.close(), 1000); });
    ws.on('close', () => resolve());
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  log('13. real stop');
'''
new = '''  const [gatewayPath] = grant.openPath.split('?');
  async function proveCodeServerChannel(type) {
    // code-server/VS Code Web opens these same remote-authority WebSocket channels.
    // Merely receiving HTTP 101 is insufficient for GPUbnb billing: wait for a
    // genuine data frame emitted by code-server and relayed Host -> API -> browser.
    const params = new URLSearchParams({
      type,
      reconnectionToken: randomUUID(),
      reconnection: 'false',
      skipWebSocketFrames: 'false',
    });
    const url = `${API.replace('http', 'ws')}${gatewayPath}/?${params}`;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { cookie: gatewayCookie } });
      let upstreamFrameSeen = false;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`${type} code-server channel produced no upstream frame in time`));
      }, 20_000);
      ws.on('message', (data) => {
        upstreamFrameSeen = true;
        clearTimeout(timer);
        log(`    ${type} upstream frame`, { bytes: Buffer.byteLength(data) });
        ws.close();
      });
      ws.on('close', () => {
        clearTimeout(timer);
        if (upstreamFrameSeen) resolve();
        else reject(new Error(`${type} code-server channel closed before any upstream frame`));
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  await proveCodeServerChannel('Management');
  await proveCodeServerChannel('ExtensionHost');

  const activated = await waitUntil('real upstream code-server frame activates billing', async () => {
    const current = await prisma.booking.findUnique({
      where: { id: booking.id },
      select: { status: true, workspaceActivatedAt: true },
    });
    return current?.status === 'ACTIVE' && current.workspaceActivatedAt ? current : null;
  }, { timeoutMs: 30_000, intervalMs: 500 });
  log('    interactive rental activated by real code-server traffic', { workspaceActivatedAt: activated.workspaceActivatedAt });

  log('13. real stop after genuine interactive activation');
'''
if s.count(old) != 1:
    raise SystemExit(f'activation block marker count={s.count(old)}')
s = s.replace(old, new, 1)

old = '''  const finalSession = await waitUntil('session reaches a terminal status', async () => {
    const s = await prisma.workspaceSession.findUnique({ where: { id: session.id }, select: { status: true } });
    return ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(s.status) ? s : null;
  }, { timeoutMs: 30_000, intervalMs: 2000 });
  log('    final session status', finalSession.status);
'''
new = '''  const finalSession = await waitUntil('session reaches COMPLETED after genuine interactive activation', async () => {
    const s = await prisma.workspaceSession.findUnique({ where: { id: session.id }, select: { status: true } });
    if (['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(s.status)) {
      throw new Error(`activated workspace ended unexpectedly: ${s.status}`);
    }
    return s.status === 'COMPLETED' ? s : null;
  }, { timeoutMs: 30_000, intervalMs: 2000 });
  log('    final session status', finalSession.status);
'''
if s.count(old) != 1:
    raise SystemExit(f'final session block marker count={s.count(old)}')
s = s.replace(old, new, 1)

s = s.replace(
    "real READY -> real access -> real activation -> real stop -> real cleanup",
    "real READY -> real access -> real Management+ExtensionHost traffic -> ACTIVE -> COMPLETED stop -> real cleanup",
)
p.write_text(s)

# Source-level contract so future harness edits cannot fall back to handshake-only activation.
t = Path('apps/api/test/e2e-code-server-activation-contract.test.ts')
t.write_text('''import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport path from 'node:path';\nimport test from 'node:test';\nimport { fileURLToPath } from 'node:url';\n\nconst here = path.dirname(fileURLToPath(import.meta.url));\nconst repoRoot = path.resolve(here, '../../..');\n\nasync function e2eSource(): Promise<string> {\n  return readFile(path.join(repoRoot, 'e2e/run.cjs'), 'utf8');\n}\n\ntest('real E2E requires upstream code-server frames on both VS Code channels', async () => {\n  const source = await e2eSource();\n  assert.match(source, /proveCodeServerChannel\\('Management'\\)/);\n  assert.match(source, /proveCodeServerChannel\\('ExtensionHost'\\)/);\n  assert.match(source, /ws\\.on\\('message'/);\n  assert.match(source, /upstreamFrameSeen = true/);\n  assert.match(source, /current\\?\\.status === 'ACTIVE' && current\\.workspaceActivatedAt/);\n});\n\ntest('real E2E requires clean COMPLETED termination after activation', async () => {\n  const source = await e2eSource();\n  assert.match(source, /session reaches COMPLETED after genuine interactive activation/);\n  assert.match(source, /s\\.status === 'COMPLETED'/);\n  assert.match(source, /\\['FAILED', 'TIMED_OUT', 'CANCELLED'\\]\\.includes\\(s\\.status\\)/);\n  assert.doesNotMatch(source, /ws\\.on\\('open', \\(\\) => \\{ clearTimeout\\(timer\\); setTimeout\\(\\(\\) => ws\\.close\\(\\), 1000\\); \\}\\)/);\n});\n''')
