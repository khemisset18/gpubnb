import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ListingResourceMode } from '@prisma/client';

import { registerRentalMarketplaceRoutes } from '../src/rental-marketplace-routes.js';

async function rentalRouteApp(resourceMode: ListingResourceMode | null) {
  const app = Fastify();
  const db = {
    gpuListing: {
      findUnique: async () => resourceMode === null ? null : { resourceMode },
      findMany: async () => [],
      findFirst: async () => null,
    },
  };
  registerRentalMarketplaceRoutes(app, db as never, {} as never);

  // These routes model the historical server.ts handlers. The rental guard is
  // intentionally registered first and must stop unsafe legacy requests before
  // either handler executes.
  app.post('/listings', async () => ({ legacyHandlerReached: true }));
  app.post('/bookings', async () => ({ legacyHandlerReached: true }));
  await app.ready();
  return app;
}

test('legacy machine-level publication is blocked before historical handler execution', async (t) => {
  const app = await rentalRouteApp(ListingResourceMode.FULL_MACHINE);
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/listings',
    payload: {},
  });

  assert.equal(response.statusCode, 410);
  assert.deepEqual(response.json(), {
    error: 'legacy_listing_publication_disabled',
    replacement: '/rental/listings',
  });
});

test('legacy FULL_MACHINE booking is blocked before historical handler execution', async (t) => {
  const app = await rentalRouteApp(ListingResourceMode.FULL_MACHINE);
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/bookings',
    payload: { listingId: 'cm000000000000000000001' },
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), { error: 'legacy_listing_not_rentable' });
});

test('SELECTED_ACCELERATORS booking reaches the historical booking transaction', async (t) => {
  const app = await rentalRouteApp(ListingResourceMode.SELECTED_ACCELERATORS);
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/bookings',
    payload: { listingId: 'cm000000000000000000001' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { legacyHandlerReached: true });
});
