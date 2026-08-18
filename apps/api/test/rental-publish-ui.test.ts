import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const webRoot = path.resolve(process.cwd(), '../web');
const sourceRoot = path.resolve(process.cwd(), 'src');

test('publish UI requires one exact server-qualified GPU', async () => {
  const html = await readFile(path.join(webRoot, 'publish.html'), 'utf8');
  const script = await readFile(path.join(webRoot, 'publish.js'), 'utf8');

  assert.match(html, /name="machineId"/);
  assert.match(html, /name="acceleratorId"/);
  assert.match(html, /GPU à louer/);
  assert.match(html, /Publication fail-closed/);
  assert.match(script, /\/rental\/machines\/manage/);
  assert.match(script, /\/rental\/machines\/\$\{encodeURIComponent\(machineId\)\}\/gpus/);
  assert.match(script, /api\('\/rental\/listings'/);
  assert.match(script, /acceleratorId:gpuSelect\.value/);
  assert.match(script, /RESOURCE_AUTHORITY_MISSING/);
  assert.match(script, /ACCELERATOR_ALREADY_LISTED/);
  assert.doesNotMatch(script, /api\('\/machines\/mine'\)/);
  assert.doesNotMatch(script, /api\('\/listings',\{method:'POST'/);
});

test('exact GPU rental routes are registered in the real API route graph', async () => {
  const root = await readFile(path.join(sourceRoot, 'device-authorization-routes.ts'), 'utf8');
  const routes = await readFile(path.join(sourceRoot, 'rental-marketplace-routes.ts'), 'utf8');

  assert.match(root, /registerRentalMarketplaceRoutes\(app, db, redis\)/);
  assert.match(routes, /app\.get\('\/rental\/listings'/);
  assert.match(routes, /app\.get\('\/rental\/listings\/:listingId\/workspaces'/);
  assert.match(routes, /app\.get\('\/rental\/machines\/manage'/);
  assert.match(routes, /app\.get\('\/rental\/machines\/:machineId\/gpus'/);
  assert.match(routes, /app\.post\('\/rental\/listings'/);
  assert.match(routes, /createExactGpuListing/);
});

test('legacy machine-level listing publication and booking are fail-closed', async () => {
  const routes = await readFile(path.join(sourceRoot, 'rental-marketplace-routes.ts'), 'utf8');
  assert.match(routes, /request\.method === 'POST'/);
  assert.match(routes, /pathname === '\/listings'/);
  assert.match(routes, /code\(410\)/);
  assert.match(routes, /legacy_listing_publication_disabled/);
  assert.match(routes, /replacement: '\/rental\/listings'/);
  assert.match(routes, /pathname === '\/bookings'/);
  assert.match(routes, /ListingResourceMode\.SELECTED_ACCELERATORS/);
  assert.match(routes, /legacy_listing_not_rentable/);
});

test('new rental listing path is SELECTED_ACCELERATORS only', async () => {
  const service = await readFile(path.join(sourceRoot, 'rental-listing-service.ts'), 'utf8');
  assert.match(service, /ListingResourceMode\.SELECTED_ACCELERATORS/);
  assert.match(service, /accelerators: \{ create: \{ acceleratorId: input\.acceleratorId \} \}/);
  assert.doesNotMatch(service, /minimumAccelerators:\s*1/);
  assert.doesNotMatch(service, /maximumAccelerators:\s*1/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /Prisma\.TransactionIsolationLevel\.Serializable/);
});

test('renter marketplace and workspace chooser use exact selected GPU routes', async () => {
  const app = await readFile(path.join(webRoot, 'app.js'), 'utf8');
  const chooser = await readFile(path.join(webRoot, 'choose-workspace.js'), 'utf8');
  assert.match(app, /jsonFetch\('\/rental\/listings'\)/);
  assert.match(app, /x\.gpu\.model/);
  assert.doesNotMatch(app, /remote=await jsonFetch\('\/listings'\)/);
  assert.match(chooser, /\/rental\/listings\/\$\{encodeURIComponent\(listingId\)\}\/workspaces/);
  assert.match(chooser, /listing\.gpu\.model/);
});
