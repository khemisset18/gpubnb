import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';

import {
  WORKSPACE_BROWSER_CSP,
  isWorkspaceBrowserPath,
  registerWorkspaceBrowserSecurity,
} from '../src/workspace-browser-security.js';

test('workspace browser CSP is scoped away from agent and API routes', () => {
  assert.equal(isWorkspaceBrowserPath('/workspace-gateway/session-1/'), true);
  assert.equal(isWorkspaceBrowserPath('/workspace-gateway/session-1/_static/app.js?x=1'), true);
  assert.equal(isWorkspaceBrowserPath('/agent/workspace-gateway/session-1/desired'), false);
  assert.equal(isWorkspaceBrowserPath('/health'), false);
});

test('workspace response overrides the strict API Helmet CSP with VS Code runtime requirements', async () => {
  const app = Fastify();
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
  });
  registerWorkspaceBrowserSecurity(app);

  app.get('/workspace-gateway/:sessionId/*', async (_request, reply) => {
    return reply.type('text/html').send('<html><body>workspace</body></html>');
  });
  app.get('/health', async () => ({ ok: true }));

  await app.ready();
  try {
    const workspace = await app.inject({ method: 'GET', url: '/workspace-gateway/session-1/' });
    assert.equal(workspace.statusCode, 200);
    assert.equal(workspace.headers['content-security-policy'], WORKSPACE_BROWSER_CSP);
    assert.match(WORKSPACE_BROWSER_CSP, /script-src[^;]*'unsafe-inline'/);
    assert.match(WORKSPACE_BROWSER_CSP, /script-src[^;]*'unsafe-eval'/);
    assert.match(WORKSPACE_BROWSER_CSP, /script-src[^;]*'wasm-unsafe-eval'/);
    assert.match(WORKSPACE_BROWSER_CSP, /style-src[^;]*'unsafe-inline'/);
    assert.match(WORKSPACE_BROWSER_CSP, /worker-src[^;]*blob:/);
    assert.match(WORKSPACE_BROWSER_CSP, /connect-src[^;]*wss:/);

    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    const apiCsp = String(health.headers['content-security-policy'] || '');
    assert.doesNotMatch(apiCsp, /'unsafe-eval'/);
    assert.doesNotMatch(apiCsp, /'unsafe-inline'/);
  } finally {
    await app.close();
  }
});

test('workspace absolute-path redirects remain inside the authenticated session prefix', async () => {
  const app = Fastify();
  registerWorkspaceBrowserSecurity(app);
  app.get('/workspace-gateway/:sessionId/redirect', async (_request, reply) => {
    return reply.redirect('/stable-abc/static/workbench.js');
  });
  app.get('/workspace-gateway/:sessionId/external', async (_request, reply) => {
    return reply.redirect('https://example.com/x');
  });

  await app.ready();
  try {
    const local = await app.inject({ method: 'GET', url: '/workspace-gateway/session-1/redirect' });
    assert.equal(local.statusCode, 302);
    assert.equal(local.headers.location, '/workspace-gateway/session-1/stable-abc/static/workbench.js');

    const external = await app.inject({ method: 'GET', url: '/workspace-gateway/session-1/external' });
    assert.equal(external.statusCode, 302);
    assert.equal(external.headers.location, 'https://example.com/x');
  } finally {
    await app.close();
  }
});
