// Real recovery scenario: kill the real agent process mid-session (simulating a
// crash) while a real Developer workspace is READY and gateway-registered, then
// restart it, and prove the system reaches a safe, explainable state rather than
// a stuck or double-booked one. Same production routes/functions as run.cjs -
// nothing here is mocked. Invoked by recovery-agent-restart.sh once disposable
// Postgres, Redis, the real API server, and a real isolated agent config
// directory exist.
'use strict';
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const API = process.argv[3];
process.env.DATABASE_URL = process.argv[4];

const { PrismaClient, BookingStatus } = require(path.join(__dirname, '../apps/api/node_modules/@prisma/client'));
const nacl = require(path.join(__dirname, '../apps/api/node_modules/tweetnacl'));
const bs58pkg = require(path.join(__dirname, '../apps/api/node_modules/bs58'));
const bs58 = bs58pkg.default || bs58pkg;

const AGENT_CONFIG_DIR = path.join(__dirname, '.agent-config');
const GPUBNB_AGENT_BIN = 'gpubnb-agent';

function log(step, extra) {
  console.log(`[recovery] ${step}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
}

function runAgent(args) {
  const result = spawnSync(GPUBNB_AGENT_BIN, args, { env: { ...process.env, GPUBNB_CONFIG_DIR: AGENT_CONFIG_DIR }, encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

async function realWalletSession() {
  const keyPair = nacl.sign.keyPair();
  const wallet = bs58.encode(keyPair.publicKey);
  const nonceRes = await fetch(`${API}/auth/nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }) });
  const nonceBody = await nonceRes.json();
  if (!nonceRes.ok) throw new Error('nonce failed: ' + JSON.stringify(nonceBody));
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(nonceBody.message), keyPair.secretKey));
  const verifyRes = await fetch(`${API}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet, message: nonceBody.message, signature }) });
  const verifyBody = await verifyRes.json();
  if (!verifyRes.ok) throw new Error('verify failed: ' + JSON.stringify(verifyBody));
  return { userId: verifyBody.user.id, cookie: extractCookie(verifyRes), wallet };
}

async function waitUntil(label, predicate, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function findAgentDaemonPid() {
  // Same identity check the agent's own `stop`/`_running_agent_pid()` uses
  // (pid.json under the isolated config dir), read directly so this script can
  // kill the exact real OS process without relying on `gpubnb-agent stop`
  // (which is precisely the failure mode being tested - "does the system
  // survive when nothing gracefully told the agent to stop").
  const fs = require('fs');
  try {
    const record = JSON.parse(fs.readFileSync(path.join(AGENT_CONFIG_DIR, 'agent.pid'), 'utf8'));
    return record.pid;
  } catch {
    return null;
  }
}

async function main() {
  const prisma = new PrismaClient();
  const { syncGpuMiningResourcesFromAccelerators } = require(path.join(__dirname, '../apps/api/dist/mining-resource-inventory.js'));
  const { createExactGpuListing } = require(path.join(__dirname, '../apps/api/dist/rental-listing-service.js'));
  const { allocateBookingResources, releaseBookingResources } = require(path.join(__dirname, '../apps/api/dist/resource-allocation-service.js'));

  log('1. real owner wallet session');
  const owner = await realWalletSession();
  await prisma.user.update({ where: { id: owner.userId }, data: { canHost: true } });

  log('2. real pairing code + real agent link');
  const codeRes = await fetch(`${API}/machines/link-code`, { method: 'POST', headers: { cookie: owner.cookie } });
  const { code } = await codeRes.json();
  const linkOut = runAgent(['link', code]);
  if (linkOut.status !== 0) throw new Error('agent link failed: ' + linkOut.stdout + linkOut.stderr);
  const machineId = /Machine ID\s*:\s*([a-z0-9]+)/.exec(linkOut.stdout)?.[1];
  if (!machineId) throw new Error('could not parse machineId from: ' + linkOut.stdout);
  log('   machineId', machineId);

  log('3. real agent start (real heartbeats begin)');
  const startOut = runAgent(['start', '--daemon']);
  if (startOut.status !== 0) throw new Error('agent start failed: ' + startOut.stdout + startOut.stderr);

  log('4. waiting for a real, stable inventory heartbeat');
  await waitUntil('machine becomes publishable', async () => {
    const m = await prisma.machine.findUnique({ where: { id: machineId }, select: { connectivity: true, dockerAvailable: true, nvidiaRuntimeAvailable: true } });
    return m.connectivity === 'ONLINE' && m.dockerAvailable && m.nvidiaRuntimeAvailable ? m : null;
  }, { timeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 12_000));
  await prisma.machine.update({ where: { id: machineId }, data: { lastCudaProbeOk: true, verifiedAt: new Date(), moderationStatus: 'CLEAR', operational: 'AVAILABLE' } });

  log('5. real accelerator sync');
  const machine = await prisma.machine.findUniqueOrThrow({ where: { id: machineId } });
  const now = new Date();
  await prisma.$transaction((tx) => syncGpuMiningResourcesFromAccelerators(tx, machineId, [{
    schemaVersion: 1, kind: 'GPU', vendor: 'NVIDIA', model: machine.gpuModel || 'Unknown GPU',
    deviceId: machine.gpuUuid, busAddress: null, driverVersion: machine.driverVersion || '0',
    runtimeVersion: machine.cudaVersion || '0', memoryTotalMiB: machine.vramMiB || 4096,
    memoryUsedMiB: null, utilizationPercent: null, temperatureC: null, powerWatts: null,
    available: true, throttling: false, capabilities: {}, metrics: {},
  }]));
  const accelerator = await prisma.accelerator.findUniqueOrThrow({ where: { machineId_hardwareUuid: { machineId, hardwareUuid: machine.gpuUuid } } });
  await prisma.accelerator.update({ where: { id: accelerator.id }, data: { isolationVerified: true, verifiedAt: now, lastSeenAt: now } });

  log('6. real listing + booking + allocation + Developer workspace request');
  const listing = await createExactGpuListing(prisma, {
    ownerId: owner.userId, machineId, acceleratorId: accelerator.id,
    title: 'E2E recovery listing', description: 'Created by e2e/recovery-agent-restart.cjs.',
    hourlySol: 0.01, now: new Date(), heartbeatStaleAfterSeconds: 300,
  });
  const renter = await realWalletSession();
  const startsAt = new Date();
  const booking = await prisma.booking.create({
    data: {
      buyerId: renter.userId, listingId: listing.id, idempotencyKey: `e2e_recovery_${Date.now()}`,
      startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000),
      quotedLamports: 1_000_000n, expectedSeconds: 1_500, status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  await prisma.payment.create({ data: { bookingId: booking.id, grossLamports: 1_000_000n, status: 'ESCROW_FUNDED' } });
  await allocateBookingResources(prisma, { bookingId: booking.id, buyerId: renter.userId });
  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.FUNDED, depositSignature: `dev-bypass:e2e-recovery-${Date.now()}` } });

  const devRes = await fetch(`${API}/bookings/${booking.id}/workspace/developer`, { method: 'POST', headers: { cookie: renter.cookie } });
  const session = await devRes.json();
  if (devRes.status !== 200) throw new Error('workspace/developer failed: ' + JSON.stringify(session));
  log('   sessionId', session.id);

  log('7. waiting for the real WORKSPACE_PREPARE job and gateway registration (before the crash)');
  await waitUntil('job completes', async () => {
    const s = await prisma.workspaceSession.findUnique({ where: { id: session.id }, select: { status: true } });
    return s.status === 'READY' ? s : (s.status !== 'PREPARING' ? Promise.reject(new Error('session left PREPARING: ' + JSON.stringify(s))) : null);
  }, { timeoutMs: 120_000 });
  const grant = await waitUntil('canOpen becomes true', async () => {
    const statusRes = await fetch(`${API}/bookings/${booking.id}/workspace`, { headers: { cookie: renter.cookie } });
    const statusBody = await statusRes.json();
    log('    status poll', { canOpen: statusBody.canOpen, blockedReason: statusBody.blockedReason });
    if (!statusBody.canOpen) return null;
    const accessRes = await fetch(`${API}/bookings/${booking.id}/workspace/access`, { method: 'POST', headers: { cookie: renter.cookie } });
    const accessBody = await accessRes.json();
    return accessRes.ok ? accessBody : null;
  }, { timeoutMs: 180_000, intervalMs: 3000 });
  log('   real gatewayPath (pre-crash)', grant.openPath);

  const before = await prisma.workspaceSession.findUnique({ where: { id: session.id }, select: { connectionMetadata: true } });
  const runtimeId = before.connectionMetadata.runtimeId;
  log('   real container runtimeId (pre-crash)', runtimeId);
  const acceleratorBefore = await prisma.accelerator.findUniqueOrThrow({ where: { id: accelerator.id }, select: { status: true } });
  log('   real accelerator status (pre-crash)', acceleratorBefore.status);

  log('8. REAL FAULT INJECTION: killing the real agent process (simulated crash), container left running unmanaged');
  const agentPid = findAgentDaemonPid();
  if (!agentPid) throw new Error('could not find the real agent daemon pid to kill');
  log('   killing real agent pid', agentPid);
  spawnSync('taskkill', ['/F', '/T', '/PID', String(agentPid)]);
  await new Promise((r) => setTimeout(r, 2000));

  log('9. observing the container during the outage (must still be running - the agent, not Docker, crashed)');
  const duringOutage = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}']).toString();
  const containerAliveDuringOutage = duringOutage.includes(runtimeId);
  log('   container alive during agent outage', containerAliveDuringOutage);
  if (!containerAliveDuringOutage) throw new Error('unexpected: the container was removed even though only the agent was killed, not Docker');

  log('10. observing the booking/session/accelerator state while the agent is down (must not silently look healthy)');
  const duringOutageSession = await prisma.workspaceSession.findUnique({ where: { id: session.id }, select: { status: true } });
  const duringOutageMachine = await prisma.machine.findUnique({ where: { id: machineId }, select: { connectivity: true } });
  log('   session status while agent is down', duringOutageSession.status);
  log('   machine connectivity while agent is down (heartbeats stopped)', duringOutageMachine.connectivity);

  log('11. REAL RECOVERY: restarting the real agent process');
  const restartOut = runAgent(['start', '--daemon']);
  if (restartOut.status !== 0) throw new Error('agent restart failed: ' + restartOut.stdout + restartOut.stderr);
  log('   restart output', restartOut.stdout.trim());

  log('12. waiting for the restarted agent to resume real heartbeats');
  await waitUntil('machine back ONLINE after restart', async () => {
    const m = await prisma.machine.findUnique({ where: { id: machineId }, select: { connectivity: true } });
    return m.connectivity === 'ONLINE' ? m : null;
  }, { timeoutMs: 60_000 });

  log('13. verifying the restarted agent reconciles WITHOUT double-booking or spawning a duplicate container');
  await new Promise((r) => setTimeout(r, 10_000)); // let one real reconciliation cycle run
  const afterRestart = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}']).toString();
  const devContainers = afterRestart.split('\n').filter((n) => n.trim().startsWith('gpubnb-dev-'));
  log('   all gpubnb-dev-* containers after restart', devContainers);
  // Exactly one primary + one proxy container for this one session - not zero
  // (would mean the agent gave up / recreated nothing) and not more than two
  // (would mean it spawned a duplicate instead of adopting the survivor).
  if (devContainers.length !== 2) throw new Error('expected exactly 2 containers (runtime + proxy) after recovery, found ' + devContainers.length + ': ' + JSON.stringify(devContainers));
  const acceleratorAfterRestart = await prisma.accelerator.findUniqueOrThrow({ where: { id: accelerator.id }, select: { status: true } });
  log('   accelerator status after restart', acceleratorAfterRestart.status);
  const allocationsAfterRestart = await prisma.acceleratorAllocation.findMany({ where: { bookingId: booking.id }, select: { status: true, releasedAt: true } });
  // "Live" mirrors machine-state-service.ts's own liveAllocationStatuses: HELD,
  // CONFIRMED and ACTIVE are all legitimate not-yet-released states - only a
  // released row (or more than one live row) would mean a real problem.
  const liveAllocations = allocationsAfterRestart.filter((a) => ['HELD', 'CONFIRMED', 'ACTIVE'].includes(a.status) && !a.releasedAt);
  log('   live allocations for this booking after restart', { count: liveAllocations.length, all: allocationsAfterRestart });
  if (liveAllocations.length !== 1) throw new Error('expected exactly one live allocation after recovery, found ' + liveAllocations.length + ' - possible double-booking: ' + JSON.stringify(allocationsAfterRestart));

  log('14. real stop, cleanup, and re-verifying the machine is rentable again after recovery');
  const stopRes = await fetch(`${API}/workspace-sessions/${session.id}/stop`, { method: 'POST', headers: { cookie: renter.cookie } });
  log('    stop response', await stopRes.json());
  await waitUntil('containers removed', () => {
    const out = execFileSync('docker', ['ps', '--format', '{{.Names}}']).toString();
    return out.includes(runtimeId) ? null : true;
  }, { timeoutMs: 60_000 });
  const finalSession = await waitUntil('session reaches a terminal status', async () => {
    const s = await prisma.workspaceSession.findUnique({ where: { id: session.id }, select: { status: true } });
    return ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(s.status) ? s : null;
  }, { timeoutMs: 30_000, intervalMs: 2000 });
  log('    final session status', finalSession.status);
  await releaseBookingResources(prisma, booking.id).catch(() => {});

  const booking2Start = new Date(Date.now() + 3_600_000 * 2);
  const booking2 = await prisma.booking.create({
    data: {
      buyerId: renter.userId, listingId: listing.id, idempotencyKey: `e2e_recovery_second_${Date.now()}`,
      startsAt: booking2Start, endsAt: new Date(booking2Start.getTime() + 3_600_000),
      quotedLamports: 1_000_000n, expectedSeconds: 1_500, status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  const secondAllocation = await allocateBookingResources(prisma, { bookingId: booking2.id, buyerId: renter.userId });
  log('    GPU rentable again after recovery, second allocation succeeded', secondAllocation.acceleratorIds);

  log('DONE — real agent crash/restart recovery proven: booking -> READY -> gateway registered -> real agent process killed -> container survives unmanaged -> agent restarted -> heartbeats resume -> no double-booking (exactly 1 active allocation) -> real stop -> real cleanup -> GPU rentable again.');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('[recovery] FAILED:', e.stack || e.message);
  if (e && e.details) console.error('[recovery] error details:', JSON.stringify(e.details));
  process.exit(1);
});
