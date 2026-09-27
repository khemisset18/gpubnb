import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  MiningMode,
  MiningResourceKind,
  MiningRuntimeState,
  PrismaClient,
} from '@prisma/client';

import { requestMiningStart } from '../src/mining-command-service.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const ROLLBACK = Symbol('deliberate-test-rollback');

function fakeLeaseRedis() {
  return {
    eval: async (_script: string, numberOfKeys: number) => {
      if (numberOfKeys === 2) return [1, 'lease_secret_probe_0001', '17', 300000];
      return [1, '300000'];
    },
    hgetall: async () => ({}),
    pttl: async () => -2,
  } as any;
}

test('real PostgreSQL START persistence contains only the local secret reference, never plaintext', { skip: !hasDb }, async (t) => {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
  } catch (error) {
    t.skip(`no reachable local Postgres for mining secret persistence test: ${(error as Error).message}`);
    await prisma.$disconnect().catch(() => {});
    return;
  }
  t.after(async () => {
    await prisma.$disconnect();
  });

  const suffix = crypto.randomBytes(6).toString('hex');
  const reference = `secret://local/mining/pool-${suffix}`;
  const plaintextSentinel = `gpubnb-postgres-secret-probe-${suffix}`;

  try {
    await prisma.$transaction(async (tx) => {
      const owner = await tx.user.create({
        data: {
          wallet: `owner_wallet_${suffix}`,
          pseudonym: `owner_secret_probe_${suffix}`,
          canHost: true,
        },
      });
      const machine = await tx.machine.create({
        data: {
          ownerId: owner.id,
          agentPublicKey: `agent_secret_probe_${suffix}`,
        },
      });
      const hardwareUuid = `GPU-secret-${suffix}`;
      const accelerator = await tx.accelerator.create({
        data: {
          machineId: machine.id,
          hardwareUuid,
          vendor: 'NVIDIA',
          model: 'NVIDIA Secret Persistence Test GPU',
          vramMiB: 8192,
        },
      });
      const resource = await tx.miningResource.create({
        data: {
          id: crypto.randomUUID(),
          machineId: machine.id,
          kind: MiningResourceKind.GPU,
          resourceKey: `gpu:${machine.id}:uuid:${hardwareUuid}`,
          displayName: 'NVIDIA Secret Persistence Test GPU',
          acceleratorId: accelerator.id,
          enabled: true,
          quarantined: false,
          runtimeState: MiningRuntimeState.IDLE,
          lastSeenAt: new Date(),
        },
      });
      await tx.miningConfiguration.create({
        data: {
          id: crypto.randomUUID(),
          resourceId: resource.id,
          mode: MiningMode.OWNER_POOL,
          profileId: 'lolminer_etchash',
          walletAddress: 'wallet.example-123',
          workerName: 'worker_secret_probe',
          ownerPoolEndpoint: 'stratum+tcp://pool.example.com:4444',
          ownerPoolSecretRef: reference,
          autoResumeAfterRental: false,
          maximumTemperatureC: 94,
          maximumPowerWatts: 180,
          platformFeeBasisPoints: 0,
          version: 3,
        },
      });

      const db = {
        $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => callback(tx),
      } as unknown as PrismaClient;
      const result = await requestMiningStart(db, fakeLeaseRedis(), {
        machineId: machine.id,
        resourceId: resource.id,
        ownerId: owner.id,
        requestId: `secret-probe-${suffix}`,
      });
      assert.ok(result.commandId);

      const command = await tx.machineCommand.findUniqueOrThrow({
        where: { id: result.commandId! },
      });
      const commandJson = JSON.stringify(command.payload);
      assert.ok(commandJson.includes(reference));
      assert.ok(!commandJson.includes(plaintextSentinel));
      assert.doesNotMatch(commandJson, /poolPassword|poolSecretValue|secretValue|seedPhrase|privateKey/);

      const runtimeEvents = await tx.miningRuntimeEvent.findMany({
        where: { resourceId: resource.id },
        select: { payload: true },
      });
      const auditEvents = await tx.miningAuditLog.findMany({
        where: { resourceId: resource.id },
        select: { previousValue: true, nextValue: true },
      });
      for (const surface of [...runtimeEvents, ...auditEvents]) {
        const serialized = JSON.stringify(surface);
        assert.ok(!serialized.includes(plaintextSentinel));
        assert.ok(!serialized.includes(reference));
      }

      const leaked = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT (
          (SELECT count(*) FROM "MachineCommand"
            WHERE "machineId" = ${machine.id}
              AND "payload"::text LIKE ${`%${plaintextSentinel}%`})
          +
          (SELECT count(*) FROM "MiningRuntimeEvent"
            WHERE "resourceId" = ${resource.id}
              AND COALESCE("payload"::text, '') LIKE ${`%${plaintextSentinel}%`})
          +
          (SELECT count(*) FROM "MiningAuditLog"
            WHERE "resourceId" = ${resource.id}
              AND (
                COALESCE("previousValue"::text, '') LIKE ${`%${plaintextSentinel}%`}
                OR COALESCE("nextValue"::text, '') LIKE ${`%${plaintextSentinel}%`}
              ))
          +
          (SELECT count(*) FROM "MiningConfiguration"
            WHERE "resourceId" = ${resource.id}
              AND COALESCE("ownerPoolSecretRef", '') LIKE ${`%${plaintextSentinel}%`})
        )::bigint AS count
      `;
      assert.equal(leaked[0]?.count, 0n);

      throw ROLLBACK;
    }, { timeout: 10_000 });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
});
