import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const candidate = resolve(process.argv[2]);
const require = createRequire(resolve(candidate, 'package.json'));
const { z } = require('zod');
const { Connection } = require('@solana/web3.js');
const constrained = z.array(z.string()).max(4).safeParse(Array(100_000).fill(42));
assert.equal(constrained.success, false);
assert.ok(constrained.error.issues.length <= 5, 'oversized collection must fail without per-element issue accumulation');
const metrics = z.record(z.string(), z.unknown()).optional();
assert.deepEqual(metrics.parse({load: 0.5, idle: true, tag: null}), {load: 0.5, idle: true, tag: null});
assert.equal(metrics.safeParse([]).success, false);
const calls = [];
const connection = new Connection('http://127.0.0.1:9', {
  fetch: async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:9');
    const request = JSON.parse(options.body);
    assert.equal(request.method, 'getVersion');
    calls.push(request);
    return new Response(JSON.stringify({jsonrpc: '2.0', id: request.id,
      result: {'solana-core': 'fixture-only', 'feature-set': 0}}), {status: 200});
  },
});
assert.deepEqual(await connection.getVersion(), {'solana-core': 'fixture-only', 'feature-set': 0});
assert.equal(calls.length, 1);
console.log(JSON.stringify({status: 'SYNTHETIC_DEPENDENCY_CHECKS_PASS', networkRequests: 0,
  actualCoreIntegrationTested: false, zodOversizedCollectionIssueCount: constrained.error.issues.length,
  scope: 'Candidate packages only; no Core business logic, chain, key, fund or production access'}, null, 2));
