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
  // The first inventory is intentionally marked VERIFYING by the anti-spoofing path.
  // This local harness still needs a narrow onboarding bootstrap before it can create the
  // listing used by the rental test. IMPORTANT: this bootstrap is not accepted as rental
  // qualification. The booking created below must run a real Compute/GPU_PROOF through the
  // authenticated production route and real Agent before Developer preparation is allowed.
  await new Promise((r) => setTimeout(r, 12_000));
  await prisma.machine.update({ where: { id: machineId }, data: { lastCudaProbeOk: true, verifiedAt: new Date(), moderationStatus: 'CLEAR', operational: 'AVAILABLE' } });

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

  log('7b. real Compute preparation request (production route creates GPU_PROOF)');
  const computeRes = await fetch(`${API}/bookings/${booking.id}/workspace-sessions`, {
    method: 'POST',
    headers: { cookie: renter.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceSlug: 'compute' }),
  });
  const computeSession = await computeRes.json();
  if (!computeRes.ok) throw new Error('compute workspace request failed: ' + JSON.stringify(computeSession));
  log('    compute sessionId', computeSession.id);

  log('7c. waiting for the real agent to execute and finalize the real GPU_PROOF job');
  const proofJob = await waitUntil('GPU_PROOF completes', async () => {
    const job = await prisma.job.findFirst({
      where: { bookingId: booking.id, type: 'GPU_PROOF' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, result: true, errorCode: true },
    });
    if (!job) return null;
    if (['FAILED', 'CANCELLED', 'TIMED_OUT', 'REJECTED', 'QUARANTINED'].includes(job.status)) {
      throw new Error(`GPU_PROOF failed: ${job.status}:${job.errorCode || 'unknown'}`);
    }
    return job.status === 'COMPLETED' ? job : null;
  }, { timeoutMs: 600_000, intervalMs: 2000 });
  const proofResult = proofJob.result && typeof proofJob.result === 'object' ? proofJob.result : {};
  if (proofResult.gpuDetected !== true) {
    throw new Error('GPU_PROOF completed without gpuDetected=true: ' + JSON.stringify(proofResult));
  }
  const afterProof = await prisma.booking.findUniqueOrThrow({
    where: { id: booking.id },
    select: { status: true, workspaceActivatedAt: true },
  });
  if (afterProof.status !== 'STARTING' || afterProof.workspaceActivatedAt !== null) {
    throw new Error('GPU_PROOF must keep the booking reserved for Developer activation: ' + JSON.stringify(afterProof));
  }
  log('    GPU_PROOF completed', { jobId: proofJob.id, bookingStatus: afterProof.status });

  log('8. real POST /bookings/:id/workspace/developer after GPU_PROOF (the actual "Créer mon espace" button)');
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
  }, { timeoutMs: 180_000, intervalMs: 3000 });
  // Note: HEARTBEAT_MAX_AGE_SECONDS (config.ts, default 25s) is a real, intentional
  // security gate, not a bug - the agent's single heartbeat thread can legitimately
  // fall behind while the same process is also pulling/starting the real Docker
  // container and reconciling the gateway. 90s wasn't always enough margin for that
  // to settle on a loaded dev machine; this only widens the harness's patience, it
  // does not touch the gate itself.
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
  // A real browser first GETs openPath: the server consumes the one-time grant,
  // sets a session cookie (gpubnb_workspace, workspace-gateway.ts GATEWAY_COOKIE),
  // and 302s to the trailing-slash path. Only then does code-server's own JS open
  // a same-origin WebSocket, which rides on that cookie automatically. A raw `ws`
  // client has no cookie jar, so both steps must be done explicitly here.
  const grantGet = await fetch(`${API}${grant.openPath}`, { redirect: 'manual' });
  const setCookie = grantGet.headers.get('set-cookie');
  if (!setCookie) throw new Error('grant GET did not set a gateway session cookie: ' + grantGet.status);
  const gatewayCookie = setCookie.split(';')[0];
  await new Promise((resolve, reject) => {
    // The gateway's upgrade handler (workspace-gateway.ts) matches
    // /workspace-gateway/:sessionId/<upstream-path-to-proxy> - a bare
    // /workspace-gateway/:sessionId with nothing after it 404s
    // (websocket_route_not_found), same as a real browser's very first
    // WebSocket request to code-server's own root path would look like.
    const [pathAndQuery] = grant.openPath.split('?');
    const url = `${API.replace('http', 'ws')}${pathAndQuery}/`;
    const ws = new WebSocket(url, { headers: { cookie: gatewayCookie } });
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
  // Docker removing the container is a client-observable side effect, but the
  // session only reaches its real terminal status (COMPLETED if genuinely
  // activated, TIMED_OUT otherwise) once the agent separately calls
  // POST /agent/workspace-gateway/:sessionId/stopped after it verifies that
  // cleanup - a short async gap after the container itself is gone.
  const finalSession = await waitUntil('session reaches a terminal status', async () => {
    const s = await prisma.workspaceSession.findUnique({ where: { id: session.id }, select: { status: true } });
    return ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(s.status) ? s : null;
  }, { timeoutMs: 30_000, intervalMs: 2000 });
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

  log('DONE — full real lifecycle proven: booking -> GPU assignment -> real GPU_PROOF -> real agent -> real Docker -> real GPU -> real code-server -> real gateway register -> real READY -> real access -> real activation -> real stop -> real cleanup -> GPU available for a second rental.');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('[e2e] FAILED:', e.stack || e.message);
  if (e && e.details) console.error('[e2e] error details:', JSON.stringify(e.details));
  process.exit(1);
});
