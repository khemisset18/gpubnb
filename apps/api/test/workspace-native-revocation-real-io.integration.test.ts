import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { createGatewayChannelLeaseGuard } from '../src/workspace-gateway-channel-lease.js';

const integration = process.env.REDIS_URL && process.env.DATABASE_URL ? test : test.skip;
function percentile(sorted: number[], p: number) {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

// Real Redis GET plus real PostgreSQL network roundtrip on ephemeral CI services.
// SELECT 1 is only a proxy, NOT an activeGatewaySession query or video playback.
// No full-fps throughput/SLO or Render deployment guarantees can be inferred.
integration('30/60 FPS x 1/4/8 streams: real ephemeral Redis/Postgres I/O timing and query counts', async () => {
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
  const db = new PrismaClient();
  const prefix = 'gpubnb:test:stage4:real-io:' + crypto.randomUUID();
  const keys: string[] = [];
  try {
    for (const fps of [30, 60] as const) {
      for (const channels of [1, 4, 8]) {
        let redisReads = 0;
        let postgresReads = 0;
        const samples: number[] = [];
        const frames = fps * channels;
        const before = performance.now();
        await Promise.all(Array.from({ length: channels }, async (_, i) => {
          const sessionId = prefix + ':s:' + i;
          const userId = 'renter-' + i;
          const browserKey = prefix + ':cookie:' + fps + ':' + channels + ':' + i;
          keys.push(browserKey);
          await redis.set(browserKey, JSON.stringify({sessionId, userId}), 'EX', 60);
          const guard = createGatewayChannelLeaseGuard({
            sessionId, userId, cacheMs: 0,
            readBrowser: async () => {
              redisReads++;
              return redis.get(browserKey);
            },
            readWorkspace: async () => {
              postgresReads++;
              // Real DB I/O, but the full authorization policy is not evaluated.
              await db.$queryRaw`SELECT 1`;
              return { renterId: userId, expiresAt: new Date(Date.now() + 60_000) };
            },
          });
          for (let frame = 0; frame < fps; frame++) {
            const started = performance.now();
            assert.equal(await guard(), true);
            samples.push(performance.now() - started);
            await new Promise(resolve => setTimeout(resolve, 1000 / fps));
          }
        }));
        assert.equal(redisReads, frames);
        assert.equal(postgresReads, frames);
        samples.sort((a, b) => a - b);
        const summary = {
          kind: 'ci-ephemeral-redis-and-postgres-select-1-not-production',
          fps, channels, checkedFrames: frames, redisReads, postgresReads,
          p50Ms: percentile(samples, 0.5),
          p95Ms: percentile(samples, 0.95),
          p99Ms: percentile(samples, 0.99),
          wallMs: performance.now() - before,
        };
        assert.ok(summary.p50Ms >= 0 && summary.p95Ms >= summary.p50Ms
          && summary.p99Ms >= summary.p95Ms);
        console.log('STAGE4_NATIVE_REAL_IO_PROXY ' + JSON.stringify(summary));
      }
    }
  } finally {
    if(keys.length) await redis.del(...keys).catch(() => undefined);
    redis.disconnect();
    await db.$disconnect();
  }
});
