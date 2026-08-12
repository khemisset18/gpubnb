import type { FastifyInstance } from 'fastify';
import { rewriteWorkspaceLocation } from './workspace-gateway-transport.js';

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

const workspaceSessionIdFromUrl = (url: string): string | null => {
  const path = url.split('?', 1)[0] || '';
  const match = path.match(/^\/workspace-gateway\/([^/]+)(?:\/|$)/);
  return match ? match[1] : null;
};

export const isWorkspaceBrowserPath = (url: string): boolean => workspaceSessionIdFromUrl(url) !== null;

export const registerWorkspaceBrowserSecurity = (app: FastifyInstance): void => {
  app.addHook('onSend', (request, reply, payload, done) => {
    const sessionId = workspaceSessionIdFromUrl(request.url);
    if (sessionId) {
      reply.header('content-security-policy', WORKSPACE_BROWSER_CSP);
      const location = reply.getHeader('location');
      if (typeof location === 'string') {
        reply.header('location', rewriteWorkspaceLocation(location, sessionId));
      }
    }
    done(null, payload);
  });
};
