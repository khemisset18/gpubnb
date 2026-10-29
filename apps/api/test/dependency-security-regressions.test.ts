import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import { Connection, SolanaJSONRPCError } from '@solana/web3.js';
import { z, ZodError } from 'zod';
import { sanitizeAccelerators } from '../src/accelerator-telemetry.js';

test('Zod rejects oversized constrained collections without accumulating per-element issues', () => {
  const parsed = z.array(z.string()).max(4).safeParse(Array(100_000).fill(42));
  assert.equal(parsed.success, false);
  if (parsed.success) throw new Error('oversized collection accepted');
  assert.equal(parsed.error.issues.length, 1);
  assert.equal(parsed.error.issues[0]?.code, 'too_big');
});

test('actual telemetry schema preserves defaults, absent optionals, nulls and error paths', () => {
  const input = {schemaVersion: 1, kind: 'GPU', vendor: 'Fixture', model: 'Fixture', deviceId: 'fixture-1', available: false};
  const parsed = sanitizeAccelerators([input])[0]!;
  assert.equal(parsed.available, false);
  assert.equal(parsed.throttling, false);
  assert.deepEqual(parsed.capabilities, {});
  assert.deepEqual(parsed.metrics, {});
  assert.equal(Object.hasOwn(parsed, 'driverVersion'), false);
  assert.equal(sanitizeAccelerators([{...input, driverVersion: null}])[0]?.driverVersion, null);
  assert.throws(() => sanitizeAccelerators([{...input, available: 'false'}]), (error: unknown) =>
    error instanceof ZodError && error.issues.some(issue =>
      issue.code === 'invalid_type' && issue.path.join('.') === '0.available'));
  assert.throws(() => sanitizeAccelerators([{...input, metrics: {count: {nested: true}}}]), ZodError);
});

function configResult(overrides: Record<string, string> = {}) {
  const script = `import {config} from './src/config.ts'; console.log(JSON.stringify({
    port:config.PORT,mainnet:config.ALLOW_MAINNET,paymentBypass:config.DEV_PAYMENT_BYPASS,
    proxy:config.TRUST_PROXY,commission:config.COMMISSION_BPS,rollout:config.AGENT_CONTROL_CHANNEL_ROLLOUT_BPS}));`;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', env: {
      PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp',
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
      REDIS_URL: 'redis://127.0.0.1:1', PLATFORM_WALLET: '11111111111111111111111111111111',
      SESSION_SECRET: 'fixture-only-session-value-'.repeat(2),
      INTERNAL_SERVICE_TOKEN: 'fixture-only-internal-value-'.repeat(2), ...overrides,
    },
  });
}

test('actual config defaults preserve production and financial guards after Zod migration', () => {
  const normal = configResult();
  assert.equal(normal.status, 0, normal.stderr);
  assert.deepEqual(JSON.parse(normal.stdout), {port: 8787, mainnet: 'false', paymentBypass: 'false', proxy: 'false', commission: 500, rollout: 0});
  for (const overrides of [{SOLANA_CLUSTER: 'mainnet-beta'}, {COMMISSION_BPS: '499'}, {PORT: '0'}, {PORT: '22.5'}]) {
    const rejected = configResult(overrides);
    assert.notEqual(rejected.status, 0, JSON.stringify(overrides));
  }
  const productionBypass = configResult({NODE_ENV: 'production', DEV_PAYMENT_BYPASS: 'true',
    REDIS_URL: 'rediss://127.0.0.1:1', PUBLIC_APP_DOMAIN: 'fixture.invalid'});
  assert.notEqual(productionBypass.status, 0);
  assert.match(productionBypass.stderr, /DEV_PAYMENT_BYPASS is forbidden/);
});

test('Fastify asynchronous validation cannot replace the validated request body', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.post('/fixture', {schema: {body: {$async: true, type: 'object',
    properties: {action: {const: 'readonly'}, value: {type: 'object'}},
    required: ['action', 'value'], additionalProperties: false}}}, async request => request.body);
  const payload = {action: 'readonly', value: {action: 'unvalidated-inner-value'}};
  const response = await app.inject({method: 'POST', url: '/fixture', payload});
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), payload);
  const rejected = await app.inject({method: 'POST', url: '/fixture', payload: {...payload, action: 'other'}});
  assert.equal(rejected.statusCode, 400);
});

test('Solana/Jayson preserves concurrent asynchronous JSON-RPC results and errors without network access', async () => {
  const requests: Array<{id: string | number; method: string}> = [];
  const connection = new Connection('http://127.0.0.1:9', {fetch: async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:9');
    const request = JSON.parse(String(options?.body));
    requests.push(request);
    await new Promise(resolve => setTimeout(resolve, request.method === 'getVersion' ? 10 : 1));
    const result = request.method === 'getVersion' ? {'solana-core': 'fixture-only', 'feature-set': 0} : 17;
    return new Response(JSON.stringify({jsonrpc: '2.0', id: request.id, result}), {status: 200});
  }});
  const [version, slot] = await Promise.all([connection.getVersion(), connection.getSlot()]);
  assert.equal(version['solana-core'], 'fixture-only');
  assert.equal(slot, 17);
  assert.equal(new Set(requests.map(request => request.id)).size, 2);
  assert.deepEqual(requests.map(request => request.method).sort(), ['getSlot', 'getVersion']);
  const failing = new Connection('http://127.0.0.1:9', {fetch: async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({jsonrpc: '2.0', id: request.id,
      error: {code: -32602, message: 'fixture-invalid-params'}}), {status: 200});
  }});
  await assert.rejects(failing.getSlot(), (error: unknown) =>
    error instanceof SolanaJSONRPCError && error.code === -32602 && error.message.includes('fixture-invalid-params'));
});
