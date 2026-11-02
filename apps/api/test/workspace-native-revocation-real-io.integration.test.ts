import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { BookingStatus, PrismaClient, WorkspaceSessionStatus } from '@prisma/client';
import { Redis } from 'ioredis';
import { createGatewayChannelLeaseGuard } from '../src/workspace-gateway-channel-lease.js';

const integration = process.env.REDIS_URL && process.env.DATABASE_URL ? test : test.skip;
// Only ephemeral test services may run this suite. Never supply production URLs.
process.env.NODE_ENV ??= 'test';
process.env.SESSION_SECRET ??= 'isolated-test-session-secret-0123456789';
process.env.INTERNAL_SERVICE_TOKEN ??= 'isolated-test-internal-token-0123456789';
process.env.PLATFORM_WALLET ??= '11111111111111111111111111111111';
function percentile(sorted: number[], p: number) {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

// The real Prisma authorization predicate, relations and result shape over
// seeded native sessions. This is a one-second paced authorization workload,
// not encoded video, a saturation test, or a production SLO qualification.
integration('30/60 FPS x 1/4/8 streams: real activeGatewaySession authorization and SQL counts', async () => {
  const { activeGatewaySession } = await import('../src/workspace-gateway.js');
  const { seedReadySession } = await import('./fixtures/native-gateway-session.js');
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
  const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  let sqlQueries = 0;
  db.$on('query', () => { sqlQueries++; });
  const prefix = 'gpubnb:test:stage4:real-auth:' + crypto.randomUUID();
  const keys: string[] = [];
  const fixtures: Awaited<ReturnType<typeof seedReadySession>>[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      fixtures.push(await seedReadySession(db, crypto.randomBytes(8).toString('hex'), {
        bookingStatus: BookingStatus.STARTING, expectedSeconds: 900,
      }));
    }
    for (const fps of [30, 60] as const) {
      for (const channels of [1, 4, 8]) {
        let redisReads = 0, authorizationQueries = 0;
        const samples: number[] = [];
        const frames = fps * channels;
        const before = performance.now(), cpuBefore = process.cpuUsage();
        const rssBefore = process.memoryUsage().rss;
        sqlQueries = 0;
        await Promise.all(fixtures.slice(0, channels).map(async (fixture, i) => {
          const sessionId = fixture.session.id, userId = fixture.renter.id;
          const browserKey = prefix + ':cookie:' + fps + ':' + channels + ':' + i;
          keys.push(browserKey);
          await redis.set(browserKey, JSON.stringify({sessionId, userId}), 'EX', 60);
          const guard = createGatewayChannelLeaseGuard({
            sessionId, userId, cacheMs: 0,
            expectedMachineId: fixture.machine.id, expectedRuntimeBackend: 'WINDOWS_NATIVE',
            readBrowser: async () => { redisReads++; return redis.get(browserKey); },
            readWorkspace: async () => { authorizationQueries++; return activeGatewaySession(db, sessionId); },
          });
          const channelStart = performance.now();
          for (let frame = 0; frame < fps; frame++) {
            const started = performance.now();
            assert.equal(await guard(), true);
            samples.push(performance.now() - started);
            // Pace by the original deadline, so slow authorization is visible
            // in wall time instead of adding a full sleep after every query.
            const remaining = channelStart + (frame + 1) * 1000 / fps - performance.now();
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
          }
        }));
        assert.equal(redisReads, frames);
        assert.equal(authorizationQueries, frames);
        assert.ok(sqlQueries >= frames, 'count actual Prisma SQL, including relation queries');
        samples.sort((a, b) => a - b);
        const summary = {
          kind: 'ci-ephemeral-real-prisma-authorization-not-video-or-production',
          fps, channels, checkedFrames: frames, redisReads, authorizationQueries, sqlQueries,
          sqlQueriesPerFrame: sqlQueries / frames,
          p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99),
          wallMs: performance.now() - before, cpuMicroseconds: process.cpuUsage(cpuBefore),
          rssBefore, rssAfter: process.memoryUsage().rss,
          // The real video delivery path additionally executes a final Redis
          // fence and queue accounting. They are NOT included in these timings.
          includesVideoQueue: false,
        };
        assert.ok(summary.p50Ms >= 0 && summary.p95Ms >= summary.p50Ms && summary.p99Ms >= summary.p95Ms);
        console.log('STAGE4_NATIVE_REAL_AUTH ' + JSON.stringify(summary));
      }
    }
    const fixture = fixtures[0]!;
    const browserKey = prefix + ':revocation';
    keys.push(browserKey);
    await redis.set(browserKey, JSON.stringify({sessionId: fixture.session.id, userId: fixture.renter.id}), 'EX', 60);
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { entered = resolve; });
    let reads = 0;
    const guard = createGatewayChannelLeaseGuard({
      sessionId: fixture.session.id, userId: fixture.renter.id, cacheMs: 0,
      readBrowser: () => redis.get(browserKey),
      readWorkspace: async () => {
        const row = await activeGatewaySession(db, fixture.session.id);
        if (++reads === 1) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
        return row;
      },
    });
    const old = guard();
    await barrier;
    await db.workspaceSession.update({where: {id: fixture.session.id}, data: {status: WorkspaceSessionStatus.STOP_REQUESTED}});
    assert.equal(await guard(), false, 'a committed DB STOP denies the fresh check');
    release();
    assert.equal(await old, false, 'known DB denial fences the older successful query');
    await db.workspaceSession.update({where: {id: fixture.session.id}, data: {status: WorkspaceSessionStatus.READY, expiresAt: new Date(0)}});
    assert.equal(await guard(), false, 'expired real workspace must deny');
  } finally {
    if(keys.length) await redis.del(...keys).catch(() => undefined);
    redis.disconnect();
    for (const fixture of fixtures.reverse()) await fixture.cleanup();
    await db.$disconnect();
  }
});
