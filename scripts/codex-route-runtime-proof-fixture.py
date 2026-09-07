from pathlib import Path

p = Path('apps/api/test/machine-diagnostics-routes.integration.test.ts')
s = p.read_text()
old = '''  const nextBody = nextResponse.json() as { diagnosticRunId: string | null; diagnosticImage: string | null };
  assert.equal(nextBody.diagnosticRunId, diagnosticRunId);

  // --- The agent for A reports a real PASS result; machine B's key must not be able to submit it ---
  const resultPath = `/agent/diagnostics/${diagnosticRunId}/result`;
  const resultBody = { machineId: machineA.id, gpuDetected: true, gpuUuid: 'GPU-real-uuid', summary: 'ok', metrics: {} };
'''
new = '''  const nextBody = nextResponse.json() as {
    diagnosticRunId: string | null;
    diagnosticImage: string | null;
    expectedRuntimeSessionIds: string[];
  };
  assert.equal(nextBody.diagnosticRunId, diagnosticRunId);
  assert.ok(Array.isArray(nextBody.expectedRuntimeSessionIds));

  // --- The agent for A reports a real PASS result; machine B's key must not be able to submit it ---
  const resultPath = `/agent/diagnostics/${diagnosticRunId}/result`;
  const resultBody = {
    machineId: machineA.id,
    gpuDetected: true,
    gpuUuid: 'GPU-real-uuid',
    summary: 'ok',
    metrics: {},
    runtimeCleanliness: {
      unexpectedContainers: [],
      unexpectedVolumes: [],
      unexpectedNetworks: [],
      expectedSessionIds: nextBody.expectedRuntimeSessionIds,
    },
  };
'''
if s.count(old) != 1:
    raise SystemExit(f'route runtime proof fixture marker count={s.count(old)}')
p.write_text(s.replace(old, new, 1))
