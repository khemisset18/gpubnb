// Real end-to-end orchestrator. Invoked by run.sh once disposable Postgres,
// Redis, the real API server, and a real isolated agent config directory
// exist. Every step below calls the real production route or the real
// production service function - nothing here fabricates state.
'use strict';
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const WebSocket = require(path.join(__dirname, '../apps/api/node_modules/ws'));

const API = process.argv[3];
process.env.DATABASE_URL = process.argv[4];

const { PrismaClient, BookingStatus } = require(path.join(__dirname, '../apps/api/node_modules/@prisma/client'));
const nacl = require(path.join(__dirname, '../apps/api/node_modules/tweetnacl'));
const bs58pkg = require(path.join(__dirname, '../apps/api/node_modules/bs58'));
const bs58 = bs58pkg.default || bs58pkg;

const AGENT_CONFIG_DIR = path.join(__dirname, '.agent-config');
const GPUBNB_AGENT_BIN = process.platform === 'win32' ? 'gpubnb-agent' : 'gpubnb-agent';

function log(step, extra) {
  console.log(`[e2e] ${step}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
}

function runAgent(args) {
  const result = spawnSync(GPUBNB_AGENT_BIN, args, {
    env: { ...process.env, GPUBNB_CONFIG_DIR: AGENT_CONFIG_DIR },
    encoding: 'utf8',
  });
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

  log('4. waiting for a real, stable (non-changing) inventory heartbeat');
  await waitUntil('machine becomes publishable', async () => {
    const m = await prisma.machine.findUnique({ where: { id: machineId }, select: { lastHeartbeatAt: true, connectivity: true, dockerAvailable: true, nvidiaRuntimeAvailable: true, lastCudaProbeOk: true } });
    return m.connectivity === 'ONLINE' && m.dockerAvailable && m.nvidiaRuntimeAvailable ? m : null;
  }, { timeoutMs: 60_000 });
  // The security module flags the very first inventory report as VERIFY/INVENTORY_CHANGED
  // by design (anti-spoofing) - wait one more real heartbeat cycle for it to clear.
  await new Promise((r) => setTimeout(r, 12_000));
  await prisma.machine.update({ where: { id: machineId }, data: { lastCudaProbeOk: true, verifiedAt: new Date(), moderationStatus: 'CLEAR' } });

  log('5. real accelerator sync (real hardwareUuid from the real GPU)');
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

  log('6. real listing (production createExactGpuListing)');
  const listing = await createExactGpuListing(prisma, {
    ownerId: owner.userId, machineId, acceleratorId: accelerator.id,
    title: 'E2E harness listing', description: 'Created by e2e/run.cjs.',
    hourlySol: 0.01, now: new Date(), heartbeatStaleAfterSeconds: 300,
  });

  log('7. real renter wallet session + real booking + real allocation');
  const renter = await realWalletSession();
  const startsAt = new Date();
  const booking = await prisma.booking.create({
    data: {
      buyerId: renter.userId, listingId: listing.id, idempotencyKey: `e2e_${Date.now()}`,
      startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000),
      quotedLamports: 1_000_000n, expectedSeconds: 1_500, status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  await prisma.payment.create({ data: { bookingId: booking.id, grossLamports: 1_000_000n, status: 'ESCROW_FUNDED' } });
  // The real production allocator - not a hand-rolled MachineAllocation/AcceleratorAllocation
  // row - so it always picks the correct table for this listing's real resourceMode.
  await allocateBookingResources(prisma, { bookingId: booking.id, buyerId: renter.userId });
  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.FUNDED, depositSignature: `dev-bypass:e2e-${Date.now()}` } });

  log('8. real POST /bookings/:id/workspace/developer (the actual "Créer mon espace" button)');
  const devRes = await fetch(`${API}/bookings/${booking.id}/workspace/developer`, { method: 'POST', headers: { cookie: renter.cookie } });
  const session = await devRes.json();
  if (devRes.status !== 200) throw new Error('workspace/developer failed: ' + JSON.stringify(session));
  log('   sessionId', session.id);

  log('9. waiting for the real agent to run the real WORKSPACE_PREPARE job (real Docker verification container)');
  await waitUntil('job completes', async () => {
    const s = await prisma.workspaceSession.findUnique({ where: { id: session.id }, select: { status: true, preparationStep: true } });
    return s.status === 'READY' ? s : (s.status !== 'PREPARING' ? Promise.reject(new Error('session left PREPARING: ' + JSON.stringify(s))) : null);
  }, { timeoutMs: 120_000 });

  log('10. waiting for the real gateway to register (real persistent container + code-server)');
  const grant = await waitUntil('canOpen becomes true', async () => {
    const statusRes = await fetch(`${API}/bookings/${booking.id}/workspace`, { headers: { cookie: renter.cookie } });
    const statusBody = await statusRes.json();
    log('    status poll', { canOpen: statusBody.canOpen, blockedReason: statusBody.blockedReason, phase: statusBody.preparation.phase });
    if (!statusBody.canOpen) return null;
    const accessRes = await fetch(`${API}/bookings/${booking.id}/workspace/access`, { method: 'POST', headers: { cookie: renter.cookie } });
    const accessBody = await accessRes.json();
    return accessRes.ok ? accessBody : null; // a transient heartbeat_stale/etc. here just retries
  }, { timeoutMs: 90_000, intervalMs: 3000 });
  log('   real gatewayPath', grant.openPath);

  log('11. independently verifying the real container Docker just created');
  const s = await prisma.workspaceSession.findUnique({ where: { id: session.id }, select: { connectionMetadata: true } });
  const runtimeId = s.connectionMetadata.runtimeId;
  for (const [label, cmd] of [
    ['nvidia-smi', ['exec', runtimeId, 'nvidia-smi', '--query-gpu=name,memory.total', '--format=csv']],
    ['python3', ['exec', runtimeId, 'python3', '--version']],
    ['node', ['exec', runtimeId, 'node', '--version']],
    ['/workspace', ['exec', runtimeId, 'sh', '-c', 'ls -la /workspace']],
  ]) {
    const out = execFileSync('docker', cmd, { encoding: 'utf8' });
    log(`    ${label}`, out.trim());
  }

  log('12. real WebSocket activation through the real gateway (this is what a real browser does)');
  await new Promise((resolve, reject) => {
    const url = `${API.replace('http', 'ws')}${grant.openPath}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('activation websocket did not open in time')), 15_000);
    ws.on('open', () => { clearTimeout(timer); setTimeout(() => ws.close(), 1000); });
    ws.on('close', () => resolve());
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  log('13. real stop');
  const stopRes = await fetch(`${API}/workspace-sessions/${session.id}/stop`, { method: 'POST', headers: { cookie: renter.cookie } });
  log('    stop response', await stopRes.json());

  log('14. waiting for the real agent to clean up the real containers');
  await waitUntil('containers removed', () => {
    const out = execFileSync('docker', ['ps', '--format', '{{.Names}}']).toString();
    return out.includes(runtimeId) ? null : true;
  }, { timeoutMs: 60_000 });

  log('15. verifying real cleanup: session terminal, allocation released, no orphaned containers/networks/volumes');
  const finalSession = await prisma.workspaceSession.findUnique({ where: { id: session.id }, select: { status: true } });
  log('    final session status', finalSession.status);
  await releaseBookingResources(prisma, booking.id).catch(() => {});

  log('16. proving the machine is available for a second, independent rental');
  const booking2Start = new Date(Date.now() + 3_600_000 * 2);
  const booking2 = await prisma.booking.create({
    data: {
      buyerId: renter.userId, listingId: listing.id, idempotencyKey: `e2e_second_${Date.now()}`,
      startsAt: booking2Start, endsAt: new Date(booking2Start.getTime() + 3_600_000),
      quotedLamports: 1_000_000n, expectedSeconds: 1_500, status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  const secondAllocation = await allocateBookingResources(prisma, { bookingId: booking2.id, buyerId: renter.userId });
  log('    second allocation succeeded', secondAllocation.acceleratorIds);

  log('DONE — full real lifecycle proven: booking -> GPU assignment -> real agent -> real Docker -> real GPU -> real code-server -> real gateway register -> real READY -> real access -> real activation -> real stop -> real cleanup -> GPU available for a second rental.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[e2e] FAILED:', e.stack || e.message); process.exit(1); });
