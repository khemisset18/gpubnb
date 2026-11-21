import assert from 'node:assert/strict';
import test from 'node:test';
import { Connection } from '@solana/web3.js';

test('web3 JSON-RPC HTTP transport works with the patched jayson browser client', async () => {
  const requests: Array<{ id: number; method: string; params: unknown[] }> = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    requests.push(request);
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { 'solana-core': '1.18.0', 'feature-set': 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const connection = new Connection('https://rpc.synthetic.invalid', {
    fetch,
    disableRetryOnRateLimit: true,
  });
  const version = await connection.getVersion();

  assert.equal(version['solana-core'], '1.18.0');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, 'getVersion');
  assert.deepEqual(requests[0]?.params, []);
});
