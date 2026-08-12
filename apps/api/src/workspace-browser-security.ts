import type { FastifyInstance } from 'fastify';

/**
 * VS Code's browser runtime uses inline bootstrap/style blocks, dynamic
 * evaluation and blob-backed workers. The API-wide Helmet CSP is deliberately
 * stricter and must not be applied to the authenticated code-server gateway.
 *
 * Keep this policy scoped to renter workspace documents only. Agent routes,
 * JSON APIs and the rest of GPUbnb continue to use the global Helmet policy.
 */
export const WORKSPACE_BROWSER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: blob:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'self' blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export const isWorkspaceBrowserPath = (url: string): boolean => {
  const path = url.split('?', 1)[0] || '';
  return /^\/workspace-gateway\/[^/]+(?:\/|$)/.test(path);
};

export const registerWorkspaceBrowserSecurity = (app: FastifyInstance): void => {
  app.addHook('onSend', (request, reply, payload, done) => {
    if (isWorkspaceBrowserPath(request.url)) {
      reply.header('content-security-policy', WORKSPACE_BROWSER_CSP);
    }
    done(null, payload);
  });
};
