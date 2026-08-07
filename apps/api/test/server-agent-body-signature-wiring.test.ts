import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('every agent endpoint carrying a body requires the raw-body-bound V2 signature', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

  assert.ok(
    source.includes('async function authenticatedAgentWithBody('),
    'authenticatedAgentWithBody must be defined',
  );

  // These routes accept a JSON body from the agent. Before C4 they were authenticated
  // with V1 only (method|path|machineId|timestamp), which never binds to the body, so an
  // in-flight body tamperer could rewrite job outcomes/log entries without invalidating
  // the signature. They must all now gate on authenticatedAgentWithBody(...,req.rawBody).
  const bodyCarryingRoutes = [
    "app.post('/agent/workspace-sessions/:id/metrics'",
    "app.post('/agent/jobs/:id/state'",
    "app.post('/agent/jobs/:id/logs'",
    "app.post('/agent/jobs/:id/complete'",
    "app.post('/agent/jobs/:id/finalize-proof'",
    "app.post('/jobs/:id/artifacts'", // C11: artifact bytes are the body — same tamper risk as any JSON body.
  ];

  for (const marker of bodyCarryingRoutes) {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `route not found: ${marker}`);
    // finalize-proof is multi-line; grab a generous window rather than a single line.
    const window = source.slice(start, start + 1200);
    assert.ok(
      window.includes('authenticatedAgentWithBody(') && window.includes('req.rawBody'),
      `${marker} must call authenticatedAgentWithBody(...,req.rawBody)`,
    );
    assert.ok(
      !window.includes('authenticatedAgent('),
      `${marker} must not fall back to the V1-only authenticatedAgent (bare call, not ...WithBody)`,
    );
  }

  // GET routes carry no body, so V1 (method|path|machineId|timestamp) remains correct there —
  // confirm they were intentionally left alone, not just missed.
  for (const marker of ["app.get('/agent/jobs/next/:machineId'", "app.get('/agent/jobs/:id/control'"]) {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `route not found: ${marker}`);
    const line = source.slice(start, source.indexOf('\n', start));
    assert.ok(line.includes('authenticatedAgent(') && !line.includes('authenticatedAgentWithBody('));
  }
});
