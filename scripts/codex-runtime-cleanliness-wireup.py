from pathlib import Path

cli_path = Path('agent/gpubnb_agent/cli.py')
cli = cli_path.read_text()
old = 'from .runtime_images import DEFAULT_DEVELOPER_IMAGE, workspace_image\n'
new = old + 'from .runtime_cleanliness import inspect_runtime_cleanliness\n'
if cli.count(old) != 1:
    raise SystemExit(f'cli import marker count={cli.count(old)}')
cli = cli.replace(old, new, 1)

old = '    result_path = f"/agent/diagnostics/{diagnostic_run_id}/result"\n    try:\n'
new = '''    result_path = f"/agent/diagnostics/{diagnostic_run_id}/result"
    expected_runtime_session_ids = pending.get("expectedRuntimeSessionIds")
    if not isinstance(expected_runtime_session_ids, list):
        expected_runtime_session_ids = []
    try:
'''
if cli.count(old) != 1:
    raise SystemExit(f'cli result-path marker count={cli.count(old)}')
cli = cli.replace(old, new, 1)

old = '        report = run_gpu_diagnostic(image, timeout_seconds)\n        metrics = report.get("metrics") if isinstance(report.get("metrics"), dict) else {}\n'
new = '''        runtime_cleanliness = inspect_runtime_cleanliness([
            value for value in expected_runtime_session_ids
            if isinstance(value, str) and value
        ])
        report = run_gpu_diagnostic(image, timeout_seconds)
        metrics = report.get("metrics") if isinstance(report.get("metrics"), dict) else {}
'''
if cli.count(old) != 1:
    raise SystemExit(f'cli diagnostic marker count={cli.count(old)}')
cli = cli.replace(old, new, 1)

old = '            "metrics": metrics,\n        })\n'
new = '            "metrics": metrics,\n            "runtimeCleanliness": runtime_cleanliness.to_api_payload(),\n        })\n'
if cli.count(old) < 1:
    raise SystemExit('cli metrics payload marker missing')
cli = cli.replace(old, new, 1)
cli_path.write_text(cli)

routes_path = Path('apps/api/src/machine-diagnostics-routes.ts')
routes = routes_path.read_text()
old = "import type { PrismaClient } from '@prisma/client';"
new = "import { WorkspaceSessionStatus, type PrismaClient } from '@prisma/client';"
if routes.count(old) != 1:
    raise SystemExit(f'routes Prisma import marker count={routes.count(old)}')
routes = routes.replace(old, new, 1)

old = '''  metrics: z.record(z.unknown()).optional(),
  error: z.string().max(500).nullable().optional(),
'''
new = '''  metrics: z.record(z.unknown()).optional(),
  runtimeCleanliness: z.object({
    unexpectedContainers: z.array(z.string().min(1).max(200)).max(64),
    unexpectedVolumes: z.array(z.string().min(1).max(200)).max(64),
    unexpectedNetworks: z.array(z.string().min(1).max(200)).max(64),
  }).strict().optional(),
  error: z.string().max(500).nullable().optional(),
'''
if routes.count(old) != 1:
    raise SystemExit(f'routes result schema marker count={routes.count(old)}')
routes = routes.replace(old, new, 1)

old = '  const orphanedAllocation = await detectAvailableRepair(db, machineId);\n'
new = '''  const cleanup = result.runtimeCleanliness;
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

  const orphanedAllocation = await detectAvailableRepair(db, machineId);
'''
if routes.count(old) != 1:
    raise SystemExit(f'routes allocation marker count={routes.count(old)}')
routes = routes.replace(old, new, 1)

old = '''    if (!pending) {
      return { diagnosticRunId: null };
    }
    return {
      diagnosticRunId: pending.id,
      diagnosticImage: config.DEV_DIAGNOSTIC_IMAGE ?? null,
      timeoutSeconds: Math.floor(DIAGNOSTIC_TIMEOUT_MS / 1000),
    };
'''
new = '''    if (!pending) {
      return { diagnosticRunId: null };
    }
    const expectedRuntimeSessions = await db.workspaceSession.findMany({
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
    return {
      diagnosticRunId: pending.id,
      diagnosticImage: config.DEV_DIAGNOSTIC_IMAGE ?? null,
      timeoutSeconds: Math.floor(DIAGNOSTIC_TIMEOUT_MS / 1000),
      expectedRuntimeSessionIds: expectedRuntimeSessions.map((session) => session.id),
    };
'''
if routes.count(old) != 1:
    raise SystemExit(f'routes pending response marker count={routes.count(old)}')
routes = routes.replace(old, new, 1)
routes_path.write_text(routes)

service_path = Path('apps/api/src/diagnostic-run-service.ts')
service = service_path.read_text()
old = "const MANDATORY_CHECK_NAMES = ['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'allocation'] as const;"
new = "const MANDATORY_CHECK_NAMES = ['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'runtimeCleanup', 'allocation'] as const;"
if service.count(old) != 1:
    raise SystemExit(f'service mandatory marker count={service.count(old)}')
service = service.replace(old, new, 1)
old = '''  nvidiaRuntime: QuarantineReasonCode.NVIDIA_RUNTIME_UNAVAILABLE,
  allocation: QuarantineReasonCode.ORPHANED_ALLOCATION,
'''
new = '''  nvidiaRuntime: QuarantineReasonCode.NVIDIA_RUNTIME_UNAVAILABLE,
  runtimeCleanup: QuarantineReasonCode.WORKSPACE_CLEANUP_FAILED,
  allocation: QuarantineReasonCode.ORPHANED_ALLOCATION,
'''
if service.count(old) != 1:
    raise SystemExit(f'service reason marker count={service.count(old)}')
service = service.replace(old, new, 1)
old = "reason: 'Diagnostic réussi : tous les critères obligatoires (agent, GPU, pilote, Docker, runtime NVIDIA) sont satisfaits.',"
new = "reason: 'Diagnostic réussi : tous les critères obligatoires (agent, GPU, pilote, Docker, runtime NVIDIA, propreté runtime) sont satisfaits.',"
if service.count(old) != 1:
    raise SystemExit(f'service clear reason marker count={service.count(old)}')
service = service.replace(old, new, 1)
service_path.write_text(service)
