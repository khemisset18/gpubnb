import type { FastifyInstance, FastifyReply } from 'fastify';
import { ListingResourceMode, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { requireSession } from './auth.js';
import { config } from './config.js';
import { listOwnerRentalGpus } from './rental-gpu-catalog.js';
import {
  RentalListingError,
  createExactGpuListing,
  listOwnerRentalMachines,
} from './rental-listing-service.js';
import { listOwnerExactGpuListings } from './rental-owner-listings.js';
import {
  getPublicExactGpuListing,
  listPublicExactGpuListings,
} from './rental-public-listings.js';
import { compatibleWorkspaceChoices } from './machine-workspace-catalog.js';

const listingInput = z.object({
  machineId: z.string().cuid(),
  acceleratorId: z.string().cuid(),
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().min(20).max(3000),
  hourlySol: z.number().positive().max(100),
}).strict();

const bookingListingInput = z.object({ listingId: z.string().cuid() }).passthrough();

function sendListingError(reply: FastifyReply, error: RentalListingError) {
  const body = { error: error.code, ...(error.details ? { details: error.details } : {}) };
  switch (error.code) {
    case 'machine_not_found':
    case 'accelerator_not_found':
      return reply.code(404).send(body);
    case 'invalid_price':
      return reply.code(400).send(body);
    case 'machine_not_publishable':
    case 'accelerator_not_publishable':
    case 'listing_conflict':
      return reply.code(409).send(body);
  }
}

export function registerRentalMarketplaceRoutes(
  app: FastifyInstance,
  db: PrismaClient,
  redis: Redis,
): void {
  app.addHook('preHandler', async (request, reply) => {
    const pathname = request.url.split('?', 1)[0];
    if (request.method === 'POST' && pathname === '/listings') {
      return reply.code(410).send({
        error: 'legacy_listing_publication_disabled',
        replacement: '/rental/listings',
      });
    }
    if (request.method === 'POST' && pathname === '/bookings') {
      const parsed = bookingListingInput.safeParse(request.body);
      if (!parsed.success) return;
      const listing = await db.gpuListing.findUnique({
        where: { id: parsed.data.listingId },
        select: { resourceMode: true },
      });
      if (listing && listing.resourceMode !== ListingResourceMode.SELECTED_ACCELERATORS) {
        return reply.code(409).send({ error: 'legacy_listing_not_rentable' });
      }
    }
  });

  app.get('/rental/listings', async () => listPublicExactGpuListings(
    db,
    new Date(),
    config.HEARTBEAT_OFFLINE_SECONDS,
  ));

  app.get('/rental/listings/:listingId/workspaces', async (request, reply) => {
    const { listingId } = z.object({ listingId: z.string().cuid() }).parse(request.params);
    const listing = await getPublicExactGpuListing(
      db,
      listingId,
      new Date(),
      config.HEARTBEAT_OFFLINE_SECONDS,
    );
    if (!listing) return reply.code(404).send({ error: 'listing_unavailable' });
    return {
      ...listing,
      workspaces: compatibleWorkspaceChoices(listing.machine),
    };
  });

  app.get('/rental/listings/manage', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: { canHost: true },
    });
    if (!user?.canHost) return reply.code(403).send({ error: 'provider_role_required' });
    return {
      listings: await listOwnerExactGpuListings(
        db,
        session.userId,
        new Date(),
        config.HEARTBEAT_OFFLINE_SECONDS,
      ),
    };
  });

  app.get('/rental/machines/manage', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: { canHost: true },
    });
    if (!user?.canHost) return reply.code(403).send({ error: 'provider_role_required' });

    return {
      machines: await listOwnerRentalMachines(
        db,
        session.userId,
        new Date(),
        config.HEARTBEAT_OFFLINE_SECONDS,
      ),
    };
  });

  app.get('/rental/machines/:machineId/gpus', async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const { machineId } = z.object({ machineId: z.string().cuid() }).parse(request.params);
    const gpus = await listOwnerRentalGpus(
      db,
      machineId,
      session.userId,
      new Date(),
      config.HEARTBEAT_OFFLINE_SECONDS,
    );
    if (!gpus) return reply.code(404).send({ error: 'machine_not_found' });
    return { machineId, gpus };
  });

  app.post('/rental/listings', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireSession(request, reply, redis);
    if (!session) return;
    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: { canHost: true },
    });
    if (!user?.canHost) return reply.code(403).send({ error: 'provider_role_required' });

    const body = listingInput.parse(request.body);
    try {
      const listing = await createExactGpuListing(db, {
        ownerId: session.userId,
        machineId: body.machineId,
        acceleratorId: body.acceleratorId,
        title: body.title,
        description: body.description,
        hourlySol: body.hourlySol,
        now: new Date(),
        heartbeatStaleAfterSeconds: config.HEARTBEAT_OFFLINE_SECONDS,
      });
      return reply.code(201).send(listing);
    } catch (error) {
      if (error instanceof RentalListingError) return sendListingError(reply, error);
      throw error;
    }
  });
}
