import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { processAcceleratorHeartbeatTransactionally } from '../src/accelerator-heartbeat-service.js';

const context = {
  machineId: 'synthetic-machine', historicalGpuUuid: null,
  sessionActive: false, rawAccelerators: [],
};

for (const code of ['P2034', 'P2028']) {
  test(`accelerator heartbeat retries ${code} without dropping Serializable isolation`, async () => {
    const options: unknown[] = [];
    const completed = { publishable: false, syntheticTransaction: true };
    const db = {
      async $transaction(_callback: unknown, transactionOptions: unknown) {
        options.push(transactionOptions);
        if (options.length === 1) {
          throw new Prisma.PrismaClientKnownRequestError('Transient transaction failure', {
            code, clientVersion: 'synthetic-test',
          });
        }
        return completed;
      },
    };
    assert.deepEqual(await processAcceleratorHeartbeatTransactionally(db as never, context), completed);
    assert.deepEqual(options, [{ isolationLevel: 'Serializable' }, { isolationLevel: 'Serializable' }]);
  });
}

test('accelerator heartbeat preserves a non-transient rejection without retrying', async () => {
  let attempts = 0;
  const rejection = new Error('accelerator_policy_rejection');
  const db = { async $transaction() { attempts++; throw rejection; } };
  await assert.rejects(processAcceleratorHeartbeatTransactionally(db as never, context), error => error === rejection);
  assert.equal(attempts, 1);
});
