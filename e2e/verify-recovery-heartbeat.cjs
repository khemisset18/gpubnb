// Post-recovery proof for e2e/recovery-agent-restart.sh.
//
// The recovery scenario deliberately kills the real Agent while a Developer
// rental is ACTIVE and restarts it. Merely observing Machine.connectivity=ONLINE
// immediately after restart is not sufficient evidence because that value can
// still be the last pre-crash state until the offline sweep runs. This verifier
// waits for a heartbeat timestamp strictly newer than the recovered Developer
// session's terminal endedAt timestamp. Since the original Agent process was
// killed before that terminal transition, such a heartbeat can only come from
// the restarted daemon that survived through normal stop/cleanup.
'use strict';
const path = require('path');

const databaseUrl = process.argv[2];
if (!databaseUrl) throw new Error('DATABASE_URL argument is required');
process.env.DATABASE_URL = databaseUrl;

const { PrismaClient } = require(path.join(__dirname, '../apps/api/node_modules/@prisma/client'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const session = await prisma.workspaceSession.findFirst({
      where: {
        status: 'COMPLETED',
        machineWorkspace: { workspace: { slug: 'developer' } },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, machineId: true, endedAt: true },
    });
    if (!session) throw new Error('no COMPLETED Developer recovery session was found');
    if (!session.endedAt) throw new Error('COMPLETED Developer recovery session has no endedAt timestamp');

    const deadline = Date.now() + 90_000;
    let lastObserved = null;
    while (Date.now() < deadline) {
      const machine = await prisma.machine.findUnique({
        where: { id: session.machineId },
        select: { connectivity: true, lastHeartbeatAt: true },
      });
      lastObserved = machine;
      if (
        machine?.connectivity === 'ONLINE'
        && machine.lastHeartbeatAt
        && machine.lastHeartbeatAt.getTime() > session.endedAt.getTime()
      ) {
        console.log('[recovery-heartbeat-proof] PASS', JSON.stringify({
          sessionId: session.id,
          machineId: session.machineId,
          endedAt: session.endedAt,
          lastHeartbeatAt: machine.lastHeartbeatAt,
        }));
        return;
      }
      await sleep(1000);
    }

    throw new Error(
      'restarted Agent did not produce a fresh post-completion heartbeat: '
      + JSON.stringify({ sessionId: session.id, endedAt: session.endedAt, machine: lastObserved }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[recovery-heartbeat-proof] FAILED:', error.stack || error.message);
  process.exit(1);
});
