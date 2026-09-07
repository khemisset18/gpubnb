import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const read = (relative: string) => readFile(path.join(repoRoot, relative), 'utf8');

type RedisContract = {
  requiredCapabilities: string[];
  stateClasses: Array<{ name: string; sourceFiles: string[]; requiredSemantics: string[] }>;
};

test('runtime topology declares every Redis capability required by the state contract', async () => {
  const contract = JSON.parse(await read('deploy/redis-state-contract.json')) as RedisContract;
  const topology = JSON.parse(await read('deploy/runtime-processes.json')) as {
    processes: Record<string, { requires?: string[] }>;
    dependencies: { redis: { configuration: string; durable: boolean; requiredSemantics: string[] } };
  };

  assert.equal(topology.dependencies.redis.configuration, 'REDIS_URL');
  assert.equal(topology.dependencies.redis.durable, false);
  assert.deepEqual(
    [...topology.dependencies.redis.requiredSemantics].sort(),
    [...contract.requiredCapabilities].sort(),
  );
  assert.ok(topology.processes.api.requires?.includes('redis'));
  assert.ok(topology.processes['delivery-worker'].requires?.includes('redis'));
});

test('one-time credentials use atomic consume-once semantics', async () => {
  const auth = await read('apps/api/src/auth.ts');
  const access = await read('apps/api/src/workspace-access.ts');
  const server = await read('apps/api/src/server.ts');

  assert.match(auth, /redis\.getdel\(key\)/);
  assert.match(access, /redis\.getdel\(`\$\{PREFIX\}\$\{digest\(token\)\}`\)/);
  assert.match(server, /redis\.getdel\(`machine-link:\$\{digest\}`\)/);
  assert.match(server, /redis\.getdel\(`agent-challenge:/);
});

test('agent anti-replay remains atomic under concurrent verification', async () => {
  const security = await read('apps/api/src/security.ts');
  assert.match(security, /redis\.set\(`agent-request:/);
  assert.match(security, /'EX',\s*60,\s*'NX'/);
});

test('presence, leases and scheduler authority retain ownership-checked atomic operations', async () => {
  const presence = await read('apps/api/src/machine-presence.ts');
  const resourceLease = await read('apps/api/src/resource-lease.ts');
  const rentalAuthority = await read('apps/api/src/rental-resource-authority.ts');
  const taskLease = await read('apps/api/src/distributed-task-lease.ts');

  assert.match(presence, /const CLAIM_SCRIPT = `/);
  assert.match(presence, /const TOUCH_SCRIPT = `/);
  assert.match(presence, /redis\.eval\(/);

  assert.match(resourceLease, /fencingToken/);
  assert.match(resourceLease, /redis\.eval\(/);
  assert.match(rentalAuthority, /fenceKey/);
  assert.match(rentalAuthority, /redis\.eval\(/);

  assert.match(taskLease, /'PX', ttlMs, 'NX'/);
  assert.match(taskLease, /redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\]/);
  assert.match(taskLease, /redis\.call\('PEXPIRE'/);
  assert.match(taskLease, /redis\.call\('DEL'/);
});

test('workspace relay keeps bounded queue and backpressure primitives', async () => {
  const gateway = await read('apps/api/src/workspace-gateway.ts');
  const queue = await read('apps/api/src/gateway-queue.ts');

  assert.match(gateway, /ENQUEUE_BOUNDED_LIST_SCRIPT/);
  assert.match(gateway, /maxItems/);
  assert.match(gateway, /maxBytes/);
  assert.match(gateway, /redis\.rpop\(/);
  assert.match(gateway, /redis\.rpush\(/);
  assert.match(queue, /redis\.rpop\(key\)/);
});

test('outbox remains durable in Postgres while Redis Streams are delivery-only', async () => {
  const worker = await read('apps/api/src/delivery-worker.ts');
  assert.match(worker, /redis\.xadd\(/);
  assert.match(worker, /ClaimedOutboxEvent/);

  const contract = JSON.parse(await read('deploy/redis-state-contract.json')) as RedisContract;
  const outbox = contract.stateClasses.find((entry) => entry.name === 'outbox-stream-publication');
  assert.ok(outbox);
  assert.ok(outbox.requiredSemantics.includes('streams'));
});
