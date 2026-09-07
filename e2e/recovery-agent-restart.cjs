// Real recovery scenario: prove a genuine active Developer rental, kill the
// real agent process mid-session, restart it, and prove the same runtime is
// safely adopted with authenticated code-server traffic restored. Invoked by
// recovery-agent-restart.sh against disposable Postgres/Redis/API state and a
// real isolated Agent config. Nothing in the rental path is mocked.
'use strict';
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const WebSocket = require(path.join(__dirname, '../apps/api/node_modules/ws'));

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
  const nonceRes = await fetch(`${API}/auth/nonce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet }),
  });
  const nonceBody = await nonceRes.json();
  if (!nonceRes.ok) throw new Error('nonce failed: ' + JSON.stringify(nonceBody));
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(nonceBody.message), keyPair.secretKey));
  const verifyRes = await fetch(`${API}/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet, message: nonceBody.message, signature }),
  });
  const verifyBody = await verifyRes.json();
  if (!verifyRes.ok) throw new Error('verify failed: ' + JSON.stringify(verifyBody));
  return { userId: verifyBody.user.id, cookie: extractCookie(verifyRes), wallet };
}

async function waitUntil(label, predicate, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function findAgentDaemonPid() {
  const fs = require('fs');
  try {
    const record = JSON.parse(fs.readFileSync(path.join(AGENT_CONFIG_DIR, 'agent.pid'), 'utf8'));
    return record.pid;
  } catch {
    return null;
  }
}

function dockerNameSet(args) {
  return new Set(
    execFileSync('docker', args, { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function runtimeResourceNames(sessionId) {
  const suffix = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-16) || 'session';
  return {
    container: `gpubnb-dev-${suffix}`,
    proxy: `gpubnb-dev-proxy-${suffix}`,
    volume: `gpubnb-workspace-${suffix}`,
    network: `gpubnb-workspace-internal-${suffix}`,
  };
}

function runtimeResourcePresence(names) {
  const containers = dockerNameSet(['ps', '-a', '--format', '{{.Names}}']);
  const volumes = dockerNameSet(['volume', 'ls', '--format', '{{.Name}}']);
  const networks = dockerNameSet(['network', 'ls', '--format', '{{.Name}}']);
  return {
    container: containers.has(names.container),
    proxy: containers.has(names.proxy),
    volume: volumes.has(names.volume),
    network: networks.has(names.network),
  };
}

function allPresent(presence) {
  return presence.container && presence.proxy && presence.volume && presence.network;
}

function allAbsent(presence) {
  return !presence.container && !presence.proxy && !presence.volume && !presence.network;
}

async function proveCodeServerChannel(type, gatewayPath, gatewayCookie) {
  const params = new URLSearchParams({
    type,
    reconnectionToken: randomUUID(),
    reconnection: 'false',
    skipWebSocketFrames: 'false',
  });
  const url = `${API.replace('http', 'ws')}${gatewayPath}/?${params}`;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie: gatewayCookie } });
    let upstreamFrameSeen = false;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`${type} code-server channel produced no upstream frame in time`));
    }, 20_000);
    ws.on('message', (data) => {
      upstreamFrameSeen = true;
      clearTimeout(timer);
      log(`    ${type} upstream frame`, { bytes: Buffer.byteLength(data) });
      ws.close();
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (upstreamFrameSeen) resolve();
      else reject(new Error(`${type} code-server channel closed before any upstream frame`));
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function proveCodeServerTraffic(label, gatewayPath, gatewayCookie, timeoutMs = 90_000) {
  return waitUntil(label, async () => {
    try {
      await proveCodeServerChannel('Management', gatewayPath, gatewayCookie);
      await proveCodeServerChannel('ExtensionHost', gatewayPath, gatewayCookie);
      return true;
    } catch (error) {
      log(`    ${label} retry`, error.message);
      return null;
    }
  }, { timeoutMs, intervalMs: 2000 });
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

  log('4. waiting for real Docker/NVIDIA inventory');
  await waitUntil('machine becomes publishable', async () => {
    const machine = await prisma.machine.findUnique({
      where: { id: machineId },
      select: { connectivity: true, dockerAvailable: true, nvidiaRuntimeAvailable: true },
    });
    return machine?.connectivity === 'ONLINE' && machine.dockerAvailable && machine.nvidiaRuntimeAvailable ? machine : null;
  }, { timeoutMs: 60_000 });
  // Narrow local onboarding bootstrap only. This is deliberately before the
  // rental; the rental below must still execute a real GPU_PROOF.
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  await prisma.machine.update({
    where: { id: machineId },
    data: { lastCudaProbeOk: true, verifiedAt: new Date(), moderationStatus: 'CLEAR', operational: 'AVAILABLE' },
  });

  log('5. real accelerator sync');
  const machine = await prisma.machine.findUniqueOrThrow({ where: { id: machineId } });
  const now = new Date();
  await prisma.$transaction((tx) => syncGpuMiningResourcesFromAccelerators(tx, machineId, [{
    schemaVersion: 1,
    kind: 'GPU',
    vendor: 'NVIDIA',
    model: machine.gpuModel || 'Unknown GPU',
    deviceId: machine.gpuUuid,
    busAddress: null,
    driverVersion: machine.driverVersion || '0',
    runtimeVersion: machine.cudaVersion || '0',
    memoryTotalMiB: machine.vramMiB || 4096,
    memoryUsedMiB: null,
    utilizationPercent: null,
    temperatureC: null,
    powerWatts: null,
    available: true,
    throttling: false,
    capabilities: {},
    metrics: {},
  }]));
  const accelerator = await prisma.accelerator.findUniqueOrThrow({
    where: { machineId_hardwareUuid: { machineId, hardwareUuid: machine.gpuUuid } },
  });
  await prisma.accelerator.update({
    where: { id: accelerator.id },
    data: { isolationVerified: true, verifiedAt: now, lastSeenAt: now },
  });

  log('6. real listing + renter booking + allocation');
  const listing = await createExactGpuListing(prisma, {
    ownerId: owner.userId,
    machineId,
    acceleratorId: accelerator.id,
    title: 'E2E recovery listing',
    description: 'Created by e2e/recovery-agent-restart.cjs.',
    hourlySol: 0.01,
    now: new Date(),
    heartbeatStaleAfterSeconds: 300,
  });
  const renter = await realWalletSession();
  const startsAt = new Date();
  const booking = await prisma.booking.create({
    data: {
      buyerId: renter.userId,
      listingId: listing.id,
      idempotencyKey: `e2e_recovery_${Date.now()}`,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      quotedLamports: 1_000_000n,
      expectedSeconds: 1_500,
      status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  await prisma.payment.create({
    data: { bookingId: booking.id, grossLamports: 1_000_000n, status: 'ESCROW_FUNDED' },
  });
  await allocateBookingResources(prisma, { bookingId: booking.id, buyerId: renter.userId });
  await prisma.booking.update({
    where: { id: booking.id },
    data: { status: BookingStatus.FUNDED, depositSignature: `dev-bypass:e2e-recovery-${Date.now()}` },
  });

  log('7. real Compute preparation request creates GPU_PROOF');
  const computeRes = await fetch(`${API}/bookings/${booking.id}/workspace-sessions`, {
    method: 'POST',
    headers: { cookie: renter.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceSlug: 'compute' }),
  });
  const computeSession = await computeRes.json();
  if (!computeRes.ok) throw new Error('compute workspace request failed: ' + JSON.stringify(computeSession));
  log('   compute sessionId', computeSession.id);

  log('8. waiting for real Agent GPU_PROOF and server-side finalization');
  const finalizedProof = await waitUntil('GPU_PROOF completes and finalizes', async () => {
    const job = await prisma.job.findFirst({
      where: { bookingId: booking.id, type: 'GPU_PROOF' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, result: true, errorCode: true },
    });
    if (!job) return null;
    if (['FAILED', 'CANCELLED', 'TIMED_OUT', 'REJECTED', 'QUARANTINED'].includes(job.status)) {
      throw new Error(`GPU_PROOF failed: ${job.status}:${job.errorCode || 'unknown'}`);
    }
    if (job.status !== 'COMPLETED') return null;
    const proofResult = job.result && typeof job.result === 'object' ? job.result : {};
    if (proofResult.gpuDetected !== true || proofResult.metrics?.containerCleaned !== true) {
      throw new Error('GPU_PROOF completed without verified GPU use and cleanup: ' + JSON.stringify(proofResult));
    }
    const bookingAfterProof = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { status: true, workspaceActivatedAt: true },
    });
    if (bookingAfterProof.status === 'FUNDED' && bookingAfterProof.workspaceActivatedAt === null) return null;
    if (bookingAfterProof.status !== 'STARTING' || bookingAfterProof.workspaceActivatedAt !== null) {
      throw new Error('GPU_PROOF must keep booking reserved before Developer activation: ' + JSON.stringify(bookingAfterProof));
    }
    return { job, booking: bookingAfterProof };
  }, { timeoutMs: 600_000, intervalMs: 2000 });
  log('   GPU_PROOF completed and finalized', { jobId: finalizedProof.job.id, bookingStatus: finalizedProof.booking.status });

  log('9. real Developer workspace request only after GPU_PROOF');
  const devRes = await fetch(`${API}/bookings/${booking.id}/workspace/developer`, {
    method: 'POST',
    headers: { cookie: renter.cookie },
  });
  const session = await devRes.json();
  if (!devRes.ok) throw new Error('workspace/developer failed: ' + JSON.stringify(session));
  log('   sessionId', session.id);

  log('10. waiting for real WORKSPACE_PREPARE and gateway registration');
  await waitUntil('workspace reaches READY', async () => {
    const current = await prisma.workspaceSession.findUnique({
      where: { id: session.id },
      select: { status: true, preparationStep: true },
    });
    if (!current) return null;
    if (current.status === 'READY') return current;
    if (current.status !== 'PREPARING') throw new Error('session left PREPARING: ' + JSON.stringify(current));
    return null;
  }, { timeoutMs: 120_000 });

  const grant = await waitUntil('canOpen becomes true', async () => {
    const statusRes = await fetch(`${API}/bookings/${booking.id}/workspace`, { headers: { cookie: renter.cookie } });
    const statusBody = await statusRes.json();
    log('    status poll', { canOpen: statusBody.canOpen, blockedReason: statusBody.blockedReason, phase: statusBody.preparation?.phase });
    if (!statusBody.canOpen) return null;
    const accessRes = await fetch(`${API}/bookings/${booking.id}/workspace/access`, {
      method: 'POST',
      headers: { cookie: renter.cookie },
    });
    const accessBody = await accessRes.json();
    return accessRes.ok ? accessBody : null;
  }, { timeoutMs: 180_000, intervalMs: 3000 });
  log('   real gatewayPath', grant.openPath);

  const before = await prisma.workspaceSession.findUniqueOrThrow({
    where: { id: session.id },
    select: { connectionMetadata: true },
  });
  const runtimeId = before.connectionMetadata.runtimeId;
  const resourceNames = runtimeResourceNames(session.id);
  if (runtimeId !== resourceNames.container) {
    throw new Error(`runtimeId does not match canonical session resource name: ${runtimeId} != ${resourceNames.container}`);
  }
  const resourcesBeforeActivation = runtimeResourcePresence(resourceNames);
  if (!allPresent(resourcesBeforeActivation)) {
    throw new Error('workspace runtime resources incomplete before activation: ' + JSON.stringify(resourcesBeforeActivation));
  }
  log('   canonical runtime resources present', resourceNames);

  log('11. consuming real one-time grant and proving genuine code-server traffic');
  const grantGet = await fetch(`${API}${grant.openPath}`, { redirect: 'manual' });
  const setCookie = grantGet.headers.get('set-cookie');
  if (!setCookie) throw new Error('grant GET did not set a gateway session cookie: ' + grantGet.status);
  const gatewayCookie = setCookie.split(';')[0];
  const [gatewayPath] = grant.openPath.split('?');
  await proveCodeServerTraffic('initial authenticated code-server traffic', gatewayPath, gatewayCookie);

  const activated = await waitUntil('booking becomes ACTIVE from genuine code-server traffic', async () => {
    const current = await prisma.booking.findUnique({
      where: { id: booking.id },
      select: { status: true, workspaceActivatedAt: true },
    });
    return current?.status === 'ACTIVE' && current.workspaceActivatedAt ? current : null;
  }, { timeoutMs: 30_000, intervalMs: 500 });
  log('   interactive rental ACTIVE', { workspaceActivatedAt: activated.workspaceActivatedAt });

  log('12. REAL FAULT: killing the Agent while the rental is genuinely ACTIVE');
  const agentPid = findAgentDaemonPid();
  if (!agentPid) throw new Error('could not find the real agent daemon pid to kill');
  log('   killing real agent pid', agentPid);
  const killed = spawnSync('taskkill', ['/F', '/T', '/PID', String(agentPid)], { encoding: 'utf8' });
  if (killed.status !== 0) {
    throw new Error('taskkill failed: ' + (killed.stdout || '') + (killed.stderr || ''));
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));

  log('13. runtime must survive the Agent crash without duplicate authority');
  const duringOutagePresence = runtimeResourcePresence(resourceNames);
  if (!allPresent(duringOutagePresence)) {
    throw new Error('runtime resources changed when only the Agent crashed: ' + JSON.stringify(duringOutagePresence));
  }
  const duringOutageSession = await prisma.workspaceSession.findUniqueOrThrow({
    where: { id: session.id },
    select: { status: true },
  });
  log('   session status while Agent is down', duringOutageSession.status);

  log('14. restarting the real Agent and waiting for heartbeats');
  const restartOut = runAgent(['start', '--daemon']);
  if (restartOut.status !== 0) throw new Error('agent restart failed: ' + restartOut.stdout + restartOut.stderr);
  await waitUntil('machine back ONLINE after restart', async () => {
    const current = await prisma.machine.findUnique({ where: { id: machineId }, select: { connectivity: true } });
    return current?.connectivity === 'ONLINE' ? current : null;
  }, { timeoutMs: 60_000 });

  log('15. restarted Agent must adopt the same runtime with one live allocation');
  await waitUntil('same runtime resources remain after reconciliation', async () => {
    const presence = runtimeResourcePresence(resourceNames);
    return allPresent(presence) ? presence : null;
  }, { timeoutMs: 60_000, intervalMs: 2000 });
  const afterRestartSession = await prisma.workspaceSession.findUniqueOrThrow({
    where: { id: session.id },
    select: { connectionMetadata: true },
  });
  if (afterRestartSession.connectionMetadata?.runtimeId !== runtimeId) {
    throw new Error('Agent restart changed runtime identity instead of adopting it');
  }
  const allocationsAfterRestart = await prisma.acceleratorAllocation.findMany({
    where: { bookingId: booking.id },
    select: { status: true, releasedAt: true },
  });
  const liveAllocations = allocationsAfterRestart.filter(
    (allocation) => ['HELD', 'CONFIRMED', 'ACTIVE'].includes(allocation.status) && !allocation.releasedAt,
  );
  if (liveAllocations.length !== 1) {
    throw new Error('expected exactly one live allocation after recovery, found ' + liveAllocations.length + ': ' + JSON.stringify(allocationsAfterRestart));
  }
  log('   same runtime adopted, live allocations', { count: liveAllocations.length });

  log('16. authenticated code-server traffic must recover after Agent restart');
  await proveCodeServerTraffic('post-restart authenticated code-server traffic', gatewayPath, gatewayCookie, 120_000);
  const stillActive = await prisma.booking.findUniqueOrThrow({
    where: { id: booking.id },
    select: { status: true, workspaceActivatedAt: true },
  });
  if (stillActive.status !== 'ACTIVE' || !stillActive.workspaceActivatedAt) {
    throw new Error('booking lost ACTIVE state after Agent recovery: ' + JSON.stringify(stillActive));
  }

  log('17. normal renter stop after recovered interactive traffic');
  const stopRes = await fetch(`${API}/workspace-sessions/${session.id}/stop`, {
    method: 'POST',
    headers: { cookie: renter.cookie },
  });
  const stopBody = await stopRes.json();
  if (!stopRes.ok) throw new Error('workspace stop failed: ' + JSON.stringify(stopBody));
  log('   stop response', stopBody);

  log('18. require COMPLETED and exact four-resource cleanup');
  const finalSession = await waitUntil('session reaches COMPLETED after recovered activation', async () => {
    const current = await prisma.workspaceSession.findUnique({
      where: { id: session.id },
      select: { status: true },
    });
    if (!current) return null;
    if (['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(current.status)) {
      throw new Error(`recovered workspace ended unexpectedly: ${current.status}`);
    }
    return current.status === 'COMPLETED' ? current : null;
  }, { timeoutMs: 60_000, intervalMs: 2000 });
  log('   final session status', finalSession.status);

  await waitUntil('container, proxy, volume and network are all absent', async () => {
    const presence = runtimeResourcePresence(resourceNames);
    return allAbsent(presence) ? presence : null;
  }, { timeoutMs: 60_000, intervalMs: 1000 });
  log('   exact per-session Docker resources removed', resourceNames);

  // The booking itself remains a time reservation in this local harness. Release
  // its resource allocation only after the real session has COMPLETED and the
  // Agent has proven runtime cleanup, then prove a later booking can allocate it.
  await releaseBookingResources(prisma, booking.id);

  log('19. proving the same GPU can be allocated to a later independent rental');
  const booking2Start = new Date(Date.now() + 3_600_000 * 2);
  const booking2 = await prisma.booking.create({
    data: {
      buyerId: renter.userId,
      listingId: listing.id,
      idempotencyKey: `e2e_recovery_second_${Date.now()}`,
      startsAt: booking2Start,
      endsAt: new Date(booking2Start.getTime() + 3_600_000),
      quotedLamports: 1_000_000n,
      expectedSeconds: 1_500,
      status: BookingStatus.AWAITING_DEPOSIT,
    },
  });
  const secondAllocation = await allocateBookingResources(prisma, {
    bookingId: booking2.id,
    buyerId: renter.userId,
  });
  log('   second allocation succeeded', secondAllocation.acceleratorIds);

  log('DONE — current recovery contract proven: real GPU_PROOF -> real Developer runtime -> real Management+ExtensionHost traffic -> ACTIVE -> Agent crash -> same runtime adopted -> traffic restored -> COMPLETED stop -> container/proxy/volume/network absent -> GPU allocatable again.');
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('[recovery] FAILED:', error.stack || error.message);
  if (error && error.details) console.error('[recovery] error details:', JSON.stringify(error.details));
  process.exit(1);
});
