import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';

// The API serves its bundled desktop UI at its own origin. Static-site builds
// retain their /api proxy contract; no hosting-provider hostname is inferred.
export function registerApiServedWebConfig(app: FastifyInstance, configPath: string): void {
  const source = readFileSync(configPath, 'utf8');
  const sameOriginDefaults = [
    'window.GPUBNB_API_URL = window.GPUBNB_API_URL || window.location.origin;',
    'window.GPUBNB_GATEWAY_URL = window.GPUBNB_GATEWAY_URL || window.location.origin;',
  ].join('\n');
  app.get('/config.js', async (_request, reply) => reply
    .header('cache-control', 'no-store')
    .type('application/javascript; charset=utf-8')
    .send(`${sameOriginDefaults}\n${source}`));
}
