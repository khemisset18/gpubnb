import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const artifactMetadataSchema = z.object({
  machineId: z.string().cuid(),
  kind: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.coerce.number().int().min(0),
});

/**
 * Installs the transport primitives required by the inline artifact route.
 *
 * The API intentionally stores artifacts below a server-owned root. `kind` therefore
 * has to be a path segment, never an arbitrary path supplied by an authenticated host.
 * The declared byte count is also authenticated metadata, so verify it against the
 * parsed body before the route computes/stores the artifact.
 */
export function registerArtifactTransportGuards(app: FastifyInstance): void {
  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
  }

  app.addHook('preValidation', async (request, reply) => {
    if (request.routeOptions.url !== '/jobs/:id/artifacts') return;

    const metadata = artifactMetadataSchema.safeParse(request.query);
    if (!metadata.success) {
      return reply.code(400).send({ error: 'invalid_artifact_metadata' });
    }
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ error: 'binary_body_required' });
    }
    if (request.body.length !== metadata.data.sizeBytes) {
      return reply.code(400).send({ error: 'artifact_size_mismatch' });
    }
  });
}
