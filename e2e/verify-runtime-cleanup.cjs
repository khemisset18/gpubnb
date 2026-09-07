// Post-run proof for e2e/run.sh. Reads the disposable database to identify the
// Developer session by its authoritative workspace relation, then proves all
// canonical per-session Docker resources are absent. This runs before run.sh's
// EXIT trap so a passing harness cannot hide leaks behind best-effort teardown.
//
// Important: a successful stop intentionally clears connectionMetadata, so this
// verifier must not try to rediscover a completed session from runtimeId.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const databaseUrl = process.argv[2];
if (!databaseUrl) throw new Error('DATABASE_URL argument is required');
process.env.DATABASE_URL = databaseUrl;

const { PrismaClient } = require(path.join(__dirname, '../apps/api/node_modules/@prisma/client'));

function dockerNameSet(args) {
  return new Set(
    execFileSync('docker', args, { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function resourceNamesForSession(sessionId) {
  const suffix = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-16) || 'session';
  return {
    container: `gpubnb-dev-${suffix}`,
    proxy: `gpubnb-dev-proxy-${suffix}`,
    volume: `gpubnb-workspace-${suffix}`,
    network: `gpubnb-workspace-internal-${suffix}`,
  };
}

function metadataRuntimeId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof value.runtimeId === 'string' ? value.runtimeId : null;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const developer = await prisma.workspaceSession.findFirst({
      where: { machineWorkspace: { workspace: { slug: 'developer' } } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, endedAt: true, connectionMetadata: true },
    });
    if (!developer) throw new Error('no Developer workspace session was found');
    if (developer.status !== 'COMPLETED') {
      throw new Error(`latest Developer workspace is not COMPLETED: ${developer.status}`);
    }
    if (!developer.endedAt) {
      throw new Error('COMPLETED Developer workspace has no endedAt timestamp');
    }

    // workspace-stop-finalizer deliberately clears connectionMetadata on a
    // successful terminal transition. A lingering runtimeId would mean the DB
    // still advertises a runtime that the Docker checks below expect to be gone.
    const lingeringRuntimeId = metadataRuntimeId(developer.connectionMetadata);
    if (lingeringRuntimeId) {
      throw new Error(`COMPLETED Developer workspace still advertises runtimeId: ${lingeringRuntimeId}`);
    }

    const names = resourceNamesForSession(developer.id);
    const containers = dockerNameSet(['ps', '-a', '--format', '{{.Names}}']);
    const volumes = dockerNameSet(['volume', 'ls', '--format', '{{.Name}}']);
    const networks = dockerNameSet(['network', 'ls', '--format', '{{.Name}}']);
    const leaked = [
      containers.has(names.container) ? names.container : null,
      containers.has(names.proxy) ? names.proxy : null,
      volumes.has(names.volume) ? names.volume : null,
      networks.has(names.network) ? names.network : null,
    ].filter(Boolean);

    if (leaked.length) {
      throw new Error(`per-session Docker cleanup incomplete: ${leaked.join(', ')}`);
    }

    console.log('[cleanup-proof] PASS', JSON.stringify({
      sessionId: developer.id,
      endedAt: developer.endedAt,
      resources: names,
    }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[cleanup-proof] FAILED:', error.stack || error.message);
  process.exit(1);
});
