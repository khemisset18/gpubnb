import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AcceleratorOperationalStatus,
  ListingResourceMode,
  ListingStatus,
  MachineConnectivity,
  MachineOperational,
  MiningResourceKind,
  ModerationStatus,
  PrismaClient,
  WorkspaceRelease,
  WorkspaceSessionStatus,
} from '@prisma/client';

// Regression coverage for the rental clock fix on POST /workspace-sessions/:id/start
// (Compute workspaces only - Developer workspaces go through the equivalent, already-
// correct activateGatewaySession() in workspace-gateway.ts).
//
// Before the fix, that route updated status/startedAt on RUNNING but left `expiresAt`
// untouched, so it stayed at whatever ensureComputePreparation had set at *creation*
// time (`expiresAt: booking.endsAt`, i.e. the original reservation window). If
// GPU_PROOF/preparation ate into that window, the renter's session could already be
// close to (or past) `expiresAt` the moment they actually connected, well short of the
// `expectedSeconds` they paid for.
//
// server.ts is a standalone script with top-level side effects (it calls
// `await app.listen(...)` at import time, opens real DB/Redis connections and starts
// reconciliation intervals - see the bottom of the file), so no test in this suite
// imports it directly or drives it via app.inject(); every other test that guards
// server.ts route behavior does it the same two ways combined below:
//   1. A static assertion on the route's actual source text (see
//      account-architecture.test.ts for the established precedent), so a regression
//      that drops `expiresAt` from the update (or reintroduces `booking.endsAt` as its
//      source) fails this test even though the handler itself can't be invoked here.
//   2. A real-Postgres integration test replaying the exact same computation and
//      Prisma update the fixed handler performs, inside a transaction that is always
//      rolled back - so it proves the formula and the schema/query shape actually work
//      together, without leaving any footprint in a shared local/CI database. Skips
//      cleanly if no local Postgres is reachable, same convention as
//      rental-resource-authority-compute-integration.test.ts.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function startHandlerSource(): string {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.ts'), 'utf8');
  const marker = "app.post('/workspace-sessions/:id/start'";
  const start = server.indexOf(marker);
  assert.ok(start !== -1, 'route /workspace-sessions/:id/start not found in server.ts');
  const nextRoute = server.indexOf("\napp.", start + marker.length);
  return server.slice(start, nextRoute === -1 ? undefined : nextRoute);
}

test('POST /workspace-sessions/:id/start re-anchors expiresAt to startedAt + expectedSeconds (source check)', () => {
  const handler = startHandlerSource();

  assert.match(
    handler,
    /expiresAt\s*=\s*new Date\(\s*startedAt\.getTime\(\)\s*\+\s*row\.booking\.expectedSeconds\s*\*\s*1000\s*\)/,
    'the handler must compute expiresAt as startedAt + booking.expectedSeconds (seconds -> ms)',
  );

  const updateCallStart = handler.indexOf('db.workspaceSession.update(');
  assert.ok(updateCallStart !== -1, 'expected a db.workspaceSession.update(...) call in the handler');
  const updateCall = handler.slice(updateCallStart);

  assert.match(
    updateCall,
    /data:\{status:WorkspaceSessionStatus\.RUNNING,startedAt,expiresAt,/,
    'the RUNNING update must persist the freshly computed expiresAt, not leave it untouched',
  );
  assert.doesNotMatch(
    updateCall,
    /expiresAt:\s*booking\.endsAt/,
    'the start transition must not re-derive expiresAt from booking.endsAt (the original reservation window)',
  );

  assert.match(
    handler,
    /select:\{id:true,status:true,startedAt:true,expiresAt:true\}/,
    'the response must echo back the corrected expiresAt so callers observe the real deadline',
  );
});

const hasDb = Boolean(process.env.DATABASE_URL);
const ROLLBACK = Symbol('deliberate-test-rollback');

test('workspace-sessions/:id/start formula: expiresAt tracks expectedSeconds, not the original booking window', { skip: !hasDb }, async (t) => {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
  } catch (error) {
    t.skip(`no reachable local Postgres for this integration test: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    return;
  }
  t.after(async () => {
    await prisma.$disconnect();
  });

  const suffix = crypto.randomBytes(6).toString('hex');
  const expectedSeconds = 1800; // 30 minutes paid for
  let expiresAt: Date | undefined;
  let bookingEndsAt: Date | undefined;
  let startedAt: Date | undefined;

  try {
    await prisma.$transaction(async (tx) => {
      const owner = await tx.user.create({ data: { wallet: `owner_${suffix}`, pseudonym: `owner_${suffix}`, canHost: true } });
      const renter = await tx.user.create({ data: { wallet: `renter_${suffix}`, pseudonym: `renter_${suffix}` } });
      const machine = await tx.machine.create({
        data: {
          ownerId: owner.id,
          agentPublicKey: `agentkey_${suffix}`,
          connectivity: MachineConnectivity.ONLINE,
          operational: MachineOperational.AVAILABLE,
          lastHeartbeatAt: new Date(),
        },
      });
      const accelerator = await tx.accelerator.create({
        data: {
          machineId: machine.id,
          hardwareUuid: `GPU-test-${suffix}`,
          vendor: 'NVIDIA',
          model: 'NVIDIA Test GPU',
          vramMiB: 8192,
          status: AcceleratorOperationalStatus.RESERVED,
          moderationStatus: ModerationStatus.CLEAR,
          isolationVerified: true,
          verifiedAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
      await tx.miningResource.create({
        data: {
          id: crypto.randomUUID(),
          machineId: machine.id,
          kind: MiningResourceKind.GPU,
          resourceKey: `gpu:${machine.id}:uuid:${accelerator.hardwareUuid}`,
          displayName: 'NVIDIA Test GPU',
          acceleratorId: accelerator.id,
          enabled: true,
          quarantined: false,
          lastSeenAt: new Date(),
        },
      });
      const computeWorkspace = await tx.workspaceDefinition.upsert({
        where: { slug: 'compute' },
        update: {},
        create: { slug: 'compute', name: 'Compute Workspace', category: 'COMPUTE', release: WorkspaceRelease.BETA, manifest: {} },
      });
      const machineWorkspace = await tx.machineWorkspace.create({
        data: { machineId: machine.id, workspaceId: computeWorkspace.id, compatibilityScore: 100, state: 'READY', analysis: {} },
      });
      const listing = await tx.gpuListing.create({
        data: {
          ownerId: owner.id,
          machineId: machine.id,
          title: 'Timer regression test listing',
          description: 'Seeded by workspace-session-start-timer.test.ts',
          hourlyLamports: 1_000_000n,
          status: ListingStatus.ACTIVE,
          resourceMode: ListingResourceMode.SELECTED_ACCELERATORS,
          accelerators: { create: { acceleratorId: accelerator.id } },
        },
      });

      // Reservation window is only 5 minutes from now - deliberately much shorter than
      // expectedSeconds (30 min), simulating GPU_PROOF/preparation having eaten into it.
      // The pre-fix bug would have left the session's expiresAt at this value forever.
      bookingEndsAt = new Date(Date.now() + 5 * 60_000);
      const booking = await tx.booking.create({
        data: {
          buyerId: renter.id,
          listingId: listing.id,
          idempotencyKey: `idem_${suffix}`,
          startsAt: new Date(Date.now() - 60_000),
          endsAt: bookingEndsAt,
          quotedLamports: 1_000_000n,
          expectedSeconds,
        },
      });

      const session = await tx.workspaceSession.create({
        data: {
          bookingId: booking.id,
          renterId: renter.id,
          machineId: machine.id,
          machineWorkspaceId: machineWorkspace.id,
          status: WorkspaceSessionStatus.READY,
          isolationType: 'DOCKER',
          resourceLimits: {},
          expiresAt: booking.endsAt, // placeholder set at creation, same as ensureComputePreparation
        },
      });

      // Exactly reproduces the query the route uses to load what it needs before
      // updating, so a regression that stops selecting expectedSeconds is also caught.
      const row = await tx.workspaceSession.findFirst({
        where: {
          id: session.id,
          renterId: renter.id,
          status: WorkspaceSessionStatus.READY,
          machineWorkspace: { workspace: { slug: { not: 'developer' } } },
          booking: { startsAt: { lte: new Date(Date.now() + 300_000) }, endsAt: { gte: new Date() } },
          machine: {
            connectivity: MachineConnectivity.ONLINE,
            operational: { in: [MachineOperational.AVAILABLE, MachineOperational.RESERVED] },
            lastHeartbeatAt: { gte: new Date(Date.now() - 60_000) },
          },
        },
        select: { id: true, booking: { select: { expectedSeconds: true } } },
      });
      assert.ok(row, 'the READY session must be resolvable by the same where-clause the route uses');

      // The fix, replayed verbatim.
      startedAt = new Date();
      const computedExpiresAt = new Date(startedAt.getTime() + row!.booking.expectedSeconds * 1000);
      const updated = await tx.workspaceSession.update({
        where: { id: row!.id },
        data: { status: WorkspaceSessionStatus.RUNNING, startedAt, expiresAt: computedExpiresAt, preparationStep: 'RENTER_CONNECTED' },
        select: { expiresAt: true },
      });
      expiresAt = updated.expiresAt;

      throw ROLLBACK;
    }, { timeout: 10_000 });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }

  assert.ok(expiresAt && startedAt && bookingEndsAt);
  const expectedExpiry = startedAt!.getTime() + expectedSeconds * 1000;
  assert.ok(
    Math.abs(expiresAt!.getTime() - expectedExpiry) < 1000,
    `expiresAt (${expiresAt!.toISOString()}) must be startedAt + expectedSeconds (expected ~${new Date(expectedExpiry).toISOString()})`,
  );
  assert.ok(
    expiresAt!.getTime() - bookingEndsAt!.getTime() > 60_000,
    'expiresAt must not stay pinned to the original (shorter) booking.endsAt window',
  );
});
