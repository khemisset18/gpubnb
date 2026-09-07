// Concurrent proof for e2e/run.sh. While the real E2E orchestrator owns a live
// Developer workspace, resolve the booking's single live accelerator allocation
// from the disposable database and ask nvidia-smi inside the actual workspace
// container which physical GPU UUID it can see. The harness passes only if that
// UUID is exactly the Accelerator.hardwareUuid that the renter leased.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const databaseUrl = process.argv[2];
if (!databaseUrl) throw new Error('DATABASE_URL argument is required');
process.env.DATABASE_URL = databaseUrl;

const { PrismaClient } = require(path.join(__dirname, '../apps/api/node_modules/@prisma/client'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeIdFrom(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return typeof metadata.runtimeId === 'string' ? metadata.runtimeId : null;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const deadline = Date.now() + 900_000;
    let lastObserved = null;

    while (Date.now() < deadline) {
      const session = await prisma.workspaceSession.findFirst({
        where: {
          machineWorkspace: { workspace: { slug: 'developer' } },
          status: { in: ['PREPARING', 'READY', 'RUNNING'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, bookingId: true, status: true, connectionMetadata: true },
      });
      const runtimeId = session ? runtimeIdFrom(session.connectionMetadata) : null;
      if (!session || !runtimeId) {
        lastObserved = { sessionId: session?.id || null, status: session?.status || null, runtimeId };
        await sleep(1000);
        continue;
      }

      const allocations = await prisma.acceleratorAllocation.findMany({
        where: {
          bookingId: session.bookingId,
          status: { in: ['HELD', 'CONFIRMED', 'ACTIVE'] },
          releasedAt: null,
        },
        select: { accelerator: { select: { hardwareUuid: true } } },
      });
      if (allocations.length !== 1) {
        lastObserved = { sessionId: session.id, runtimeId, liveAllocations: allocations.length };
        await sleep(1000);
        continue;
      }

      const leasedGpuUuid = allocations[0].accelerator.hardwareUuid;
      try {
        const visible = execFileSync('docker', [
          'exec', runtimeId, 'nvidia-smi', '--query-gpu=uuid', '--format=csv,noheader',
        ], { encoding: 'utf8', timeout: 15_000 }).trim();
        const visibleUuids = visible.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        if (visibleUuids.length !== 1 || visibleUuids[0] !== leasedGpuUuid) {
          throw new Error(
            `workspace GPU identity mismatch: visible=${JSON.stringify(visibleUuids)} leased=${leasedGpuUuid}`,
          );
        }
        console.log('[exact-gpu-uuid-proof] PASS', JSON.stringify({
          sessionId: session.id,
          runtimeId,
          leasedGpuUuid,
          visibleGpuUuid: visibleUuids[0],
        }));
        return;
      } catch (error) {
        if (String(error?.message || error).includes('workspace GPU identity mismatch')) throw error;
        lastObserved = { sessionId: session.id, runtimeId, leasedGpuUuid, dockerError: error?.message || String(error) };
        await sleep(1000);
      }
    }

    throw new Error('timed out waiting to prove exact leased GPU UUID inside Developer workspace: ' + JSON.stringify(lastObserved));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[exact-gpu-uuid-proof] FAILED:', error.stack || error.message);
  process.exit(1);
});