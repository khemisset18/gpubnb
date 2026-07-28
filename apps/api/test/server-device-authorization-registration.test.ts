import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('registers device authorization routes after security plugins and hooks', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const registration = source.indexOf('registerDeviceAuthorizationRoutes(app, db, redis);');
  assert.ok(registration > source.indexOf('await app.register(cookie)'));
  assert.ok(registration > source.indexOf('await app.register(rateLimit'));
  assert.ok(registration > source.indexOf("app.addHook('onRequest'"));
  assert.ok(registration < source.indexOf("app.get('/health'"));
  assert.equal(source.match(/registerDeviceAuthorizationRoutes\(app, db, redis\);/g)?.length, 1);
});
