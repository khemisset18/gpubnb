import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('static dependency upgrade preserves files, fallback, caching, ranges and traversal protection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gpubnb-static-test-'));
  const app = Fastify();
  try {
    await writeFile(path.join(root, 'index.html'), '<html>GPUbnb test</html>');
    await writeFile(path.join(root, 'sample.txt'), '0123456789');
    await app.register(fastifyStatic, { root, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/internal/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
    const file = await app.inject('/sample.txt');
    assert.equal(file.statusCode, 200);
    assert.equal(file.body, '0123456789');
    assert.match(file.headers['content-type']!, /^text\/plain/);
    const head = await app.inject({ method: 'HEAD', url: '/sample.txt' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], '10');
    const cached = await app.inject({ url: '/sample.txt', headers: { 'if-none-match': file.headers.etag! } });
    assert.equal(cached.statusCode, 304);
    const range = await app.inject({ url: '/sample.txt', headers: { range: 'bytes=2-5' } });
    assert.equal(range.statusCode, 206);
    assert.equal(range.body, '2345');
    assert.equal((await app.inject('/rental-page')).body, '<html>GPUbnb test</html>');
    for (const url of ['/api/missing', '/internal/missing']) assert.equal((await app.inject(url)).statusCode, 404);
    for (const url of ['/%2e%2e/%2e%2e/etc/passwd', '/%00sample.txt']) {
      const response = await app.inject(url);
      assert.ok([400, 403, 404].includes(response.statusCode) || response.body === '<html>GPUbnb test</html>');
      assert.ok(!response.body.includes('root:'));
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
