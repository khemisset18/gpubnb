import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { resolveReleaseIdentity } from './release-identity.js';

export function privateWebSocketCspSource(request: {headers:{host?:string|undefined}}): string {
  const host=request.headers.host;
  return host && /^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host) ? `wss://${host}` : "'none'";
}

/** Private same-origin HTML and API are one deployment, with one exact identity. */
export function registerPrivateBrowserConfig(app: FastifyInstance, configPath: string) {
  app.get('/config.js', async (_request, reply) => {
    const identity = resolveReleaseIdentity();
    if (!identity.commit) return reply.code(503).send({error:'private_browser_release_identity_missing'});
    const source = await readFile(configPath, 'utf8');
    if (!source.includes('BEGIN_PRIVATE_HTTPS_SAME_ORIGIN')) {
      return reply.code(503).send({error:'private_browser_same_origin_config_missing'});
    }
    const build = {commit:identity.commit.slice(0,7), releaseCommit:identity.commit, environment:'private-qualification'};
    return reply.header('Cache-Control','no-store').type('application/javascript')
      .send(`${source}\nObject.assign(window.GPUBNB_BUILD, ${JSON.stringify(build)});\n`);
  });
}
