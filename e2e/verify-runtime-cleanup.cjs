// Post-run proof for e2e/run.sh. Reads the disposable database to identify the
// Developer session that actually registered a Docker runtime, then proves all
// canonical per-session Docker resources are absent. This runs before run.sh's
// EXIT trap so a passing harness cannot hide leaks behind best-effort teardown.
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

async function main() {
  const prisma = new PrismaClient();
  try {
    const sessions = await prisma.workspaceSession.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, status: true, connectionMetadata: true },
    });
    const developer = sessions.find((session) => {
      const metadata = session.connectionMetadata;
      return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        && typeof metadata.runtimeId === 'string'
        && metadata.runtimeId.startsWith('gpubnb-dev-');
    });
    if (!developer) throw new Error('no Developer workspace with a registered runtime was found');
    if (developer.status !== 'COMPLETED') {
      throw new Error(`latest registered Developer workspace is not COMPLETED: ${developer.status}`);
    }

    const names = resourceNamesForSession(developer.id);
    const runtimeId = developer.connectionMetadata.runtimeId;
    if (runtimeId !== names.container) {
      throw new Error(`registered runtimeId does not match canonical container name: ${runtimeId} != ${names.container}`);
    }

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

    console.log('[cleanup-proof] PASS', JSON.stringify({ sessionId: developer.id, resources: names }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[cleanup-proof] FAILED:', error.stack || error.message);
  process.exit(1);
});
