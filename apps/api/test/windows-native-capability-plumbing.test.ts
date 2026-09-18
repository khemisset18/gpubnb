import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const sourceRoot = path.resolve(process.cwd(), 'src');

test('Windows native desktop capability is persisted in Prisma but remains diagnostic-only', async () => {
  const schema = await readFile(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const migration = await readFile(
    path.resolve(process.cwd(), 'prisma/migrations/20260918012000_add_native_desktop_streaming_available/migration.sql'),
    'utf8',
  );
  assert.match(schema, /nativeDesktopStreamingAvailable Boolean @default\(false\)/);
  assert.match(schema, /nativeDesktopStreamingGpuUuid String\? @db\.VarChar\(200\)/);
  assert.match(migration, /ADD COLUMN "nativeDesktopStreamingAvailable" BOOLEAN NOT NULL DEFAULT false/);
});

test('only a v2 body-signed heartbeat may update the Windows native capability', async () => {
  const server = await readFile(path.join(sourceRoot, 'server.ts'), 'utf8');
  assert.match(server, /nativeDesktopStreamingAvailable:z\.boolean\(\)\.optional\(\)/);
  assert.match(server, /nativeDesktopStreamingGpuUuid:z\.string\(\).*?\.nullable\(\)\.optional\(\)/);
  assert.match(
    server,
    /b\.telemetry&&\(b\.nativeDesktopStreamingAvailable!==undefined\|\|b\.os!==undefined\)\?\{nativeDesktopStreamingAvailable:/,
  );
  assert.match(
    server,
    /startsWith\('windows'\)&&\(b\.nativeDesktopStreamingAvailable\?\?false\)/,
  );

  const linkStart = server.indexOf("app.post('/agent/link'");
  const linkEnd = server.indexOf("app.get('/machines/mine'", linkStart);
  assert.ok(linkStart >= 0 && linkEnd > linkStart);
  assert.doesNotMatch(
    server.slice(linkStart, linkEnd),
    /nativeDesktopStreaming(?:Available|GpuUuid)/,
    'link-code inventory must never prequalify the Windows native backend',
  );
});

test('owner diagnostics expose Linux and Windows desktop capabilities separately', async () => {
  const routes = await readFile(path.join(sourceRoot, 'machine-diagnostics-routes.ts'), 'utf8');
  assert.match(routes, /linuxDesktopGpuRenderingAvailable: machine\.desktopGpuRenderingAvailable/);
  assert.match(routes, /windowsNativeDesktopStreamingAvailable: machine\.nativeDesktopStreamingAvailable/);
  assert.match(routes, /windowsNativeDesktopStreamingGpuUuid: machine\.nativeDesktopStreamingGpuUuid/);
});


test('signed Windows native capability keeps availability and exact GPU proof coherent', async () => {
  const server = await readFile(path.join(sourceRoot, 'server.ts'), 'utf8');
  assert.match(server, /incoherent_native_desktop_capability/);
  assert.match(server, /nativeDesktopStreamingAvailable===true&&\(!nativeOs\.startsWith\('windows'\)\|\|!nativeUuid\)/);
  assert.match(server, /nativeDesktopStreamingAvailable!==true&&nativeUuid/);
  assert.match(server, /nativeDesktopStreamingGpuUuid:.*?nativeDesktopStreamingAvailable===true\?\(b\.nativeDesktopStreamingGpuUuid\?\?null\):null/);
});


test('positive Windows native proof must bind to an available NVIDIA GPU in the same signed accelerator inventory', async () => {
  const server = await readFile(path.join(sourceRoot, 'server.ts'), 'utf8');
  assert.match(server, /sanitizeAccelerators\(b\.telemetry\.accelerators\)/);
  assert.match(server, /accelerator\.kind==='GPU'/);
  assert.match(server, /accelerator\.available/);
  assert.match(server, /accelerator\.vendor\.trim\(\)\.toLowerCase\(\)==='nvidia'/);
  assert.match(server, /accelerator\.deviceId\.toLowerCase\(\)===nativeUuid\.toLowerCase\(\)/);
  assert.match(server, /!nativeGpuPresent/);
});

test('Windows native proof UUID accepts only canonical physical NVIDIA GPU UUIDs', async () => {
  const server = await readFile(path.join(sourceRoot, 'server.ts'), 'utf8');
  assert.match(
    server,
    /nativeDesktopStreamingGpuUuid:z\.string\(\)\.trim\(\)\.regex\(\/\^GPU-\[0-9A-Fa-f\]\{8\}-/,
  );
});
