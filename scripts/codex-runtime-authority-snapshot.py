from pathlib import Path

# Agent: echo the exact authority snapshot used for the Docker classification.
cli_path = Path('agent/gpubnb_agent/cli.py')
cli = cli_path.read_text()
old = '''            **({"runtimeCleanliness": runtime_cleanliness.to_api_payload()} if runtime_cleanliness is not None else {}),
'''
new = '''            **({
                "runtimeCleanliness": {
                    **runtime_cleanliness.to_api_payload(),
                    "expectedSessionIds": [
                        value for value in expected_runtime_session_ids
                        if isinstance(value, str) and value
                    ],
                },
            } if runtime_cleanliness is not None else {}),
'''
if cli.count(old) != 1:
    raise SystemExit(f'cli runtime payload marker count={cli.count(old)}')
cli_path.write_text(cli.replace(old, new, 1))

# API: centralize the query and reject a stale authority snapshot at result time.
routes_path = Path('apps/api/src/machine-diagnostics-routes.ts')
routes = routes_path.read_text()
old = "import { WorkspaceSessionStatus, type PrismaClient } from '@prisma/client';\n"
new = old + "import { MAX_RUNTIME_EXPECTED_SESSIONS, runtimeExpectationMatches } from './runtime-cleanliness-authority.js';\n"
if routes.count(old) != 1:
    raise SystemExit(f'routes authority import marker count={routes.count(old)}')
routes = routes.replace(old, new, 1)

old = '''  runtimeCleanliness: z.object({
    unexpectedContainers: z.array(z.string().min(1).max(200)).max(64),
    unexpectedVolumes: z.array(z.string().min(1).max(200)).max(64),
    unexpectedNetworks: z.array(z.string().min(1).max(200)).max(64),
  }).strict().optional(),
'''
new = '''  runtimeCleanliness: z.object({
    unexpectedContainers: z.array(z.string().min(1).max(200)).max(64),
    unexpectedVolumes: z.array(z.string().min(1).max(200)).max(64),
    unexpectedNetworks: z.array(z.string().min(1).max(200)).max(64),
    expectedSessionIds: z.array(z.string().cuid()).max(MAX_RUNTIME_EXPECTED_SESSIONS),
  }).strict().optional(),
'''
if routes.count(old) != 1:
    raise SystemExit(f'routes schema marker count={routes.count(old)}')
routes = routes.replace(old, new, 1)

anchor = '''async function buildChecksFromDiagnosticResult(
'''
helper = '''async function currentRuntimeSessionIds(db: PrismaClient, machineId: string): Promise<string[]> {
  const sessions = await db.workspaceSession.findMany({
    where: {
      machineId,
      status: { in: [
        WorkspaceSessionStatus.PREPARING,
        WorkspaceSessionStatus.READY,
        WorkspaceSessionStatus.RUNNING,
        WorkspaceSessionStatus.STOP_REQUESTED,
        WorkspaceSessionStatus.STOPPING,
      ] },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_RUNTIME_EXPECTED_SESSIONS,
  });
  return sessions.map((session) => session.id);
}

'''
if routes.count(anchor) != 1:
    raise SystemExit(f'routes build-check anchor count={routes.count(anchor)}')
routes = routes.replace(anchor, helper + anchor, 1)

old = '''  const cleanup = result.runtimeCleanliness;
  const unexpectedRuntimeResources = cleanup
    ? [...cleanup.unexpectedContainers, ...cleanup.unexpectedVolumes, ...cleanup.unexpectedNetworks]
    : [];
  checks.push({
    name: 'runtimeCleanup',
    status: !cleanup ? 'UNKNOWN' : unexpectedRuntimeResources.length === 0 ? 'PASS' : 'FAIL',
    value: !cleanup
      ? null
      : unexpectedRuntimeResources.length === 0
        ? 'aucune ressource runtime orpheline'
        : `${unexpectedRuntimeResources.length} ressource(s) runtime inattendue(s)`,
    details: !cleanup
      ? "L'agent n'a fourni aucune preuve d'inventaire Docker pour ce diagnostic. Mise à jour de l'agent requise avant levée de quarantaine."
      : unexpectedRuntimeResources.length === 0
        ? 'Les containers, proxies, volumes et réseaux GPUbnb présents correspondent uniquement aux sessions autorisées par le serveur.'
        : `Ressources GPUbnb inattendues détectées sur l'hôte : ${unexpectedRuntimeResources.slice(0, 12).join(', ')}`,
    measuredAt,
    source: 'agent-diagnostic',
  });
'''
new = '''  const cleanup = result.runtimeCleanliness;
  const currentExpectedRuntimeSessionIds = cleanup
    ? await currentRuntimeSessionIds(db, machineId)
    : [];
  const authoritySnapshotCurrent = Boolean(
    cleanup && runtimeExpectationMatches(cleanup.expectedSessionIds, currentExpectedRuntimeSessionIds),
  );
  const unexpectedRuntimeResources = cleanup
    ? [...cleanup.unexpectedContainers, ...cleanup.unexpectedVolumes, ...cleanup.unexpectedNetworks]
    : [];
  checks.push({
    name: 'runtimeCleanup',
    status: !cleanup || !authoritySnapshotCurrent
      ? 'UNKNOWN'
      : unexpectedRuntimeResources.length === 0
        ? 'PASS'
        : 'FAIL',
    value: !cleanup
      ? null
      : !authoritySnapshotCurrent
        ? 'autorité runtime modifiée pendant le diagnostic'
        : unexpectedRuntimeResources.length === 0
          ? 'aucune ressource runtime orpheline'
          : `${unexpectedRuntimeResources.length} ressource(s) runtime inattendue(s)`,
    details: !cleanup
      ? "L'agent n'a fourni aucune preuve d'inventaire Docker pour ce diagnostic. Mise à jour de l'agent requise avant levée de quarantaine."
      : !authoritySnapshotCurrent
        ? "Les sessions runtime autorisées ont changé entre l'assignation et le résultat. Le snapshot est périmé : relancez le diagnostic avant toute levée de quarantaine."
        : unexpectedRuntimeResources.length === 0
          ? 'Les containers, proxies, volumes et réseaux GPUbnb présents correspondent uniquement aux sessions autorisées par le serveur.'
          : `Ressources GPUbnb inattendues détectées sur l'hôte : ${unexpectedRuntimeResources.slice(0, 12).join(', ')}`,
    measuredAt,
    source: 'agent-diagnostic',
  });
'''
if routes.count(old) != 1:
    raise SystemExit(f'routes cleanup check marker count={routes.count(old)}')
routes = routes.replace(old, new, 1)

old = '''    const expectedRuntimeSessions = await db.workspaceSession.findMany({
      where: {
        machineId,
        status: { in: [
          WorkspaceSessionStatus.PREPARING,
          WorkspaceSessionStatus.READY,
          WorkspaceSessionStatus.RUNNING,
          WorkspaceSessionStatus.STOP_REQUESTED,
          WorkspaceSessionStatus.STOPPING,
        ] },
      },
      select: { id: true },
      take: 64,
    });
'''
new = '''    const expectedRuntimeSessionIds = await currentRuntimeSessionIds(db, machineId);
'''
if routes.count(old) != 1:
    raise SystemExit(f'routes assignment query marker count={routes.count(old)}')
routes = routes.replace(old, new, 1)
old = '''      expectedRuntimeSessionIds: expectedRuntimeSessions.map((session) => session.id),
'''
new = '''      expectedRuntimeSessionIds,
'''
if routes.count(old) != 1:
    raise SystemExit(f'routes assignment payload marker count={routes.count(old)}')
routes = routes.replace(old, new, 1)
routes_path.write_text(routes)

# Agent payload tests: the new server must receive the exact snapshot used by the agent.
test_path = Path('agent/tests/test_runtime_cleanliness_diagnostic_payload.py')
test = test_path.read_text()
old = '''        self.assertEqual(result["runtimeCleanliness"], evidence)
        self.assertNotIn("clean", result["runtimeCleanliness"])
'''
new = '''        self.assertEqual(
            result["runtimeCleanliness"],
            {**evidence, "expectedSessionIds": expected},
        )
        self.assertNotIn("clean", result["runtimeCleanliness"])
'''
if test.count(old) != 1:
    raise SystemExit(f'agent payload test marker count={test.count(old)}')
test_path.write_text(test.replace(old, new, 1))
