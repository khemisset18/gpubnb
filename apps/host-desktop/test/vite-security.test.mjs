import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {get} from 'node:http';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {createServer, normalizePath} from 'vite';

const require = createRequire(import.meta.url);
const request = (base, pathname) => new Promise((resolve, reject) => {
  get(new URL(pathname, base), {headers: {host: '127.0.0.1'}}, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', data => {body += data;});
    response.on('end', () => resolve({status: response.statusCode, body}));
  }).on('error', reject);
});

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpubnb-vite-security-'));
  const root = path.join(directory, 'project');
  await mkdir(root);
  const sentinel = 'DISPOSABLE_FIXTURE_CONTENT_NEVER_SERVE';
  const outside = path.join(directory, 'outside.txt');
  await writeFile(outside, sentinel);
  await writeFile(path.join(root, 'safe.txt'), 'ALLOWED_FIXTURE');
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, '.env'), sentinel);
  await writeFile(path.join(root, 'fixture.pem'), sentinel);
  const server = await createServer({configFile: false, root, logLevel: 'silent', clearScreen: false, appType: 'custom', server: {host: '127.0.0.1', port: 0, hmr: false, fs: {strict: true, allow: [root]}}});
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert.equal(address.address, '127.0.0.1');
    await run({server, root, outside, sentinel, base: `http://127.0.0.1:${address.port}`});
  } finally {await server.close(); await rm(directory, {recursive: true, force: true});}
}

test('real loopback HTTP server serves permitted files and denies outside/env/key/wasm requests', {timeout: 15000}, async () => {
  await fixture(async ({base, outside, sentinel}) => {
    const allowed = await request(base, '/safe.txt');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, 'ALLOWED_FIXTURE');
    for (const pathname of [`/@fs/${normalizePath(outside)}`, `/.env`, '/.env?raw', '/fixture.pem', '/fixture.pem?import', `/@fs/${normalizePath(outside)}?vite-wasm-instance`, `/@fs/${normalizePath(outside)}?raw`]) {
      const denied = await request(base, pathname);
      assert.equal(denied.status, 403, pathname);
      assert.ok(!denied.body.includes(sentinel), pathname);
    }
  });
});

// The root-relative/absolute shadowing vulnerability is POSIX-specific upstream.
if (process.platform !== 'win32') test('an imported project shadow file cannot allow the corresponding outside absolute file', {timeout: 15000}, async () => {
  await fixture(async ({root, outside, base, sentinel}) => {
    const shadow = path.join(root, outside.slice(1));
    await mkdir(path.dirname(shadow), {recursive: true});
    await writeFile(shadow, 'PROJECT_DECOY');
    await writeFile(path.join(root, 'main.js'), `import ${JSON.stringify('./' + outside.slice(1))};`);
    assert.equal((await request(base, '/main.js')).status, 200);
    const denied = await request(base, `/@fs/${outside}`);
    assert.equal(denied.status, 403);
    assert.ok(!denied.body.includes(sentinel));
  });
});

test('custom middleware inline-module URLs remain on the local origin for hostile request URLs', {timeout: 15000}, async () => {
  await fixture(async ({server, base}) => {
    for (const url of ['//attacker.invalid/fixture?x=1', '/%2f%2fattacker.invalid/fixture', '//attacker.invalid/payload.js?/../../package.json', '/fixture?x=%22/%3E%3Cscript%20src=%22https://attacker.invalid/fixture%22%3E']) {
      const html = await server.transformIndexHtml(url, '<html><script type="module">window.__fixture=1;</script></html>');
      const sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
      assert.ok(sources.length >= 2);
      for (const source of sources) assert.equal(new URL(source, base).origin, new URL(base).origin);
      assert.ok(!html.includes('<script src="https://attacker.invalid'));
    }
  });
});

test('actual bundled Windows editor helpers reject percent/newline arguments and normalize paths before editor flags', async () => {
  const bundle = await readFile(path.join(path.dirname(require.resolve('vite/package.json')), 'dist/node/chunks/config.js'), 'utf8');
  function bundled(name, dependencies = {}) {
    const marker = `var ${name} = /* @__PURE__ */ __commonJSMin(((exports, module) => {`;
    const start = bundle.indexOf(marker);
    assert.ok(start >= 0, `Review changed Vite bundle: ${name}`);
    const body = bundle.slice(start + marker.length, bundle.indexOf('\n}));', start));
    return runInNewContext(`const module={exports:{}}; const exports=module.exports; ${body}; module.exports;`, {
      process: {platform: 'win32', env: {}},
      __require: name => {if (name === 'path') return path.win32; if (name === 'os') return {release: () => 'fixture'}; if (name === 'url') return require('node:url'); throw new Error('Forbidden module in isolated helper fixture: ' + name);},
      ...dependencies,
    }, {timeout: 1000});
  }
  const construct = bundled('require_construct_windows_launch_command');
  for (const argument of ['C:\\fixture\\%FIXTURE%.ts', 'C:\\fixture\\line\n.ts', 'C:\\fixture\\line\r.ts']) assert.throws(() => construct('fixture-editor', [argument]), /Cannot launch/);
  assert.equal(construct('fixture-editor', ['C:\\fixture\\safe.ts']), 'fixture-editor C:\\fixture\\safe.ts');
  const parse = bundled('require_parse_file');
  assert.equal(parse('C:\\fixture\\nested\\..:12:4').fileName, 'C:\\fixture');
  const args = bundled('require_get_args');
  const actual = args('vim', '-fixture', '12', '4');
  assert.ok(path.win32.isAbsolute(actual.at(-1)));
  assert.ok(!/^[+-]/.test(actual.at(-1)));
  // These execute actual bundled helpers only. No editor or child process exists.
});
