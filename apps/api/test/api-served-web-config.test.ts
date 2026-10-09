import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { registerApiServedWebConfig } from '../src/api-served-web-config.js';

const configPath = fileURLToPath(new URL('../../web/config.js', import.meta.url));

test('API-served UI config uses its same origin without accepting request-host configuration', async () => {
  const app = Fastify();
  registerApiServedWebConfig(app, configPath);
  try {
    const response = await app.inject({ url: '/config.js', headers: { host: 'untrusted.invalid' } });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type']!, /application\/javascript/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.body, /untrusted\.invalid/);
    const window = { location: { origin: 'https://qualification.example' } } as Record<string, any>;
    runInNewContext(response.body, { window });
    assert.equal(window.GPUBNB_CONFIG.apiBase, window.location.origin);
    assert.equal(window.GPUBNB_CONFIG.workspaceGatewayBase, window.location.origin);
    const configured = { location: window.location, GPUBNB_API_URL: 'https://api.example', GPUBNB_GATEWAY_URL: 'https://gateway.example' } as Record<string, any>;
    runInNewContext(response.body, { window: configured });
    assert.equal(configured.GPUBNB_CONFIG.apiBase, 'https://api.example');
    assert.equal(configured.GPUBNB_CONFIG.workspaceGatewayBase, 'https://gateway.example');
  } finally {
    await app.close();
  }
});

test('static-site config retains the /api proxy and configured gateway defaults', () => {
  const window = { location: { origin: 'https://static.example' } } as Record<string, any>;
  runInNewContext(readFileSync(configPath, 'utf8'), { window });
  assert.equal(window.GPUBNB_CONFIG.apiBase, '/api');
  assert.equal(window.GPUBNB_CONFIG.workspaceGatewayBase, 'http://localhost:3000');
});
