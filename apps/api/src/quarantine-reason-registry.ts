import { QuarantineReasonCode } from '@prisma/client';

export type ReasonSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export type QuarantineReasonDefinition = {
  code: QuarantineReasonCode;
  title: string;
  description: string;
  severity: ReasonSeverity;
  impact: string;
  /** Exact, mechanical condition that assigns this code - the same wording an
   * engineer reading the source would use, not marketing copy. */
  triggerConditions: string;
  /** What evidence a human (or this system) needs to see before trusting that
   * this reason applies - what to look for in MachineQuarantineEvent.details,
   * DiagnosticRun.checks, or the agent's own logs. */
  evidenceRequired: string;
  /** Plain-language next step shown to the owner in Host. */
  recommendedAction: string;
  /** Whether resolving this reason requires a real DiagnosticRun (true for
   * everything except a handful of already-instantaneous corrections). */
  diagnosticRequired: boolean;
  /** Whether machine-repair-service.ts has (or could reasonably have) a safe,
   * GPUbnb-owned-bookkeeping-only automated repair for this specific cause. */
  repairPossible: boolean;
  /** Whether a passing diagnostic can, on its own evidence, ever clear this
   * quarantine via diagnostic-run-service.ts's completeDiagnosticRun() - false
   * only for causes serious enough that policy requires a human admin decision
   * even after the machine reports healthy again (see machine-diagnostics-routes.ts's
   * force-clear confirmRisk gate for CRITICAL-severity codes). */
  autoExitPossible: boolean;
};

/**
 * Single source of truth for every quarantine reason code the platform can
 * assign. The code itself is what other code may branch on; the rest is what
 * a human sees in Host. Never invent a free-text reason where a code from this
 * table applies - add a new code here instead of a raw string, and never fall
 * back to a bare generic message like "RESOURCE_QUARANTINED" when a precise
 * business reason is knowable.
 */
export const QUARANTINE_REASON_REGISTRY: Record<QuarantineReasonCode, QuarantineReasonDefinition> = {
  CRITICAL_GPU_IDENTITY_CHANGE: {
    code: 'CRITICAL_GPU_IDENTITY_CHANGE',
    title: "Changement critique d'identité GPU pendant une session",
    description:
      "Le matériel GPU rapporté par l'agent a changé de façon critique (accélérateur retiré ou identité modifiée) alors qu'une session de location était active.",
    severity: 'CRITICAL',
    impact: "Toutes les annonces de cette machine sont masquées, publication et réservation sont impossibles. Les sessions actives sont arrêtées et les paiements en cours sont gelés en attente de vérification.",
    triggerConditions: "Une session est active sur la machine ET l'agent rapporte un accélérateur disparu ou dont l'identité matérielle a changé depuis la dernière vérification.",
    evidenceRequired: "WorkspaceSessionEvent 'ACCELERATOR_SECURITY_QUARANTINE' du booking concerné (details.reason), et le diagnostic accélérateur du prochain heartbeat.",
    recommendedAction: "Vérifiez physiquement que le bon GPU est toujours installé et reconnu par le pilote, puis relancez un diagnostic.",
    diagnosticRequired: true,
    repairPossible: false,
    autoExitPossible: true,
  },
  DIAGNOSTIC_COMPLETION_RACE: {
    code: 'DIAGNOSTIC_COMPLETION_RACE',
    title: 'Session Developer active après libération de la ressource GPU',
    description:
      "La réservation associée à cette session Developer s'est terminée alors que la ressource GPU allouée avait déjà été libérée ailleurs, créant un état incohérent.",
    severity: 'CRITICAL',
    impact: 'La session concernée est arrêtée de force, publication et réservation sont impossibles, et le paiement est mis en attente de règlement manuel.',
    triggerConditions: "Une session Developer reste active/en préparation alors que sa réservation est déjà COMPLETED et que la ressource GPU associée a été réattribuée.",
    evidenceRequired: "WorkspaceSessionEvent 'DIAGNOSTIC_COMPLETION_RACE_QUARANTINED' (details.bookingId) sur la session Developer concernée.",
    recommendedAction: "Relancez un diagnostic pour confirmer qu'aucun conteneur de la session précédente ne reste actif, puis appliquez le nettoyage d'allocation si proposé.",
    diagnosticRequired: true,
    repairPossible: true,
    autoExitPossible: true,
  },
  STALE_CLAIM: {
    code: 'STALE_CLAIM',
    title: 'Revendication de ressource GPU non prouvée',
    description:
      "L'agent n'a pas pu prouver que le GPU était réellement libre (quiescence) avant de démarrer une nouvelle location, ou une revendication précédente est restée bloquée sans preuve.",
    severity: 'CRITICAL',
    impact: 'La ressource GPU concernée reste verrouillée localement par l’agent tant qu’une nouvelle preuve de quiescence n’est pas apportée ; publication et réservation sont impossibles.',
    triggerConditions: "Le superviseur de préemption GPU de l'agent (gpu_rental_preemption.py) ne peut pas prouver l'état QUIESCENT d'une ressource avant de l'attribuer à une nouvelle session.",
    evidenceRequired: "Fichier local de l'agent gpu-resource-rental-v1.json (état QUARANTINED d'une resource_id précise, avec session_id et horodatage).",
    recommendedAction: "Vérifiez qu'aucun processus tiers n'utilise encore le GPU sur la machine, puis relancez un diagnostic.",
    diagnosticRequired: true,
    repairPossible: false,
    autoExitPossible: true,
  },
  STALE_JOB: {
    code: 'STALE_JOB',
    title: 'Tâche agent restée bloquée sans confirmation de nettoyage',
    description:
      "Une tâche (diagnostic, préparation de Workspace, etc.) est restée assignée à l'agent au-delà du délai attendu, sans qu'aucune confirmation de nettoyage n'ait été reçue.",
    severity: 'CRITICAL',
    impact: "Comme l'API ne peut pas prouver que la tâche a été proprement nettoyée côté agent, la machine est bloquée par sécurité (publication et réservation impossibles) plutôt que remise disponible sans preuve.",
    triggerConditions: 'Une tâche déjà réclamée par un agent (ASSIGNED/DOWNLOADING/PREPARING/RUNNING/UPLOADING_RESULTS) dépasse son bail (lease) sans renouvellement.',
    evidenceRequired: "Job.status=TIMED_OUT/FAILED avec errorCode='job_stale_timeout' pour cette machine (voir job-staleness-sweep.ts).",
    recommendedAction: "Vérifiez que l'agent est bien démarré et connecté à Internet, puis relancez un diagnostic.",
    diagnosticRequired: true,
    repairPossible: false,
    autoExitPossible: true,
  },
  WORKSPACE_CLEANUP_FAILED: {
    code: 'WORKSPACE_CLEANUP_FAILED',
    title: "Fin de session Workspace sans confirmation de nettoyage",
    description:
      "L'agent a signalé la fin d'une session Workspace interactive (Developer, Cloud Desktop, etc.) sans confirmer que l'environnement isolé avait été correctement nettoyé.",
    severity: 'CRITICAL',
    impact: "La machine est bloquée (publication et réservation impossibles) jusqu'à preuve qu'aucune donnée ni processus du précédent locataire ne subsiste.",
    triggerConditions: "POST /agent/workspace-gateway/:sessionId/stopped est reçu avec cleaned !== true.",
    evidenceRequired: "WorkspaceSession.status=QUARANTINED sur la session concernée, corrélée par sessionId dans l'historique de quarantaine.",
    recommendedAction: "Vérifiez sur la machine qu'aucun conteneur GPUbnb résiduel ne tourne (docker ps), nettoyez-le manuellement si besoin, puis relancez un diagnostic.",
    diagnosticRequired: true,
    repairPossible: false,
    autoExitPossible: true,
  },
  AGENT_SECURITY_FAILURE: {
    code: 'AGENT_SECURITY_FAILURE',
    title: 'Échecs de signature agent répétés',
    description:
      "Plusieurs requêtes signées de cet agent n'ont pas pu être vérifiées cryptographiquement en quelques minutes, ce qui peut indiquer une clé compromise, une horloge désynchronisée ou une tentative de contrefaçon.",
    severity: 'CRITICAL',
    impact: 'La machine est mise hors ligne et bloquée par précaution de sécurité (publication et réservation impossibles).',
    triggerConditions: '8 échecs de vérification de signature ou plus pour cette machine en moins de 15 minutes.',
    evidenceRequired: "Compteur Redis security-fail:agent:<machineId> au moment de l'incident (TTL 15 min - non consultable rétroactivement passé ce délai ; c'est précisément pourquoi cet événement d'historique existe : il survit, lui, à l'expiration du compteur).",
    recommendedAction: "Vérifiez l'horloge système de la machine (NTP) et qu'aucune autre installation de l'agent n'utilise la même clé, puis relancez un diagnostic.",
    diagnosticRequired: true,
    repairPossible: false,
    autoExitPossible: true,
  },
  GPU_HEALTH_CHECK_FAILED: {
    code: 'GPU_HEALTH_CHECK_FAILED',
    title: 'Le diagnostic GPU a échoué',
    description: "Le dernier diagnostic réel exécuté par l'agent sur cette machine n'a pas confirmé un GPU sain et utilisable.",
    severity: 'CRITICAL',
    impact: 'La machine ne peut pas être publiée ni louée tant que ce diagnostic ne repasse pas au vert.',
    triggerConditions: "Un DiagnosticRun se termine avec le check 'gpu' à FAIL ou UNKNOWN.",
    evidenceRequired: "DiagnosticRun.checks (le check nommé 'gpu'), consultable dans l'historique et sur la page État & diagnostics.",
    recommendedAction: "Vérifiez le GPU et son pilote sur la machine (nvidia-smi), puis relancez un diagnostic.",
    diagnosticRequired: true,
    repairPossible: false,
    autoExitPossible: true,
  },
  ORPHANED_ALLOCATION: {
    code: 'ORPHANED_ALLOCATION',
    title: 'Allocation GPU orpheline détectée',
    description:
      "Le diagnostic a détecté une réservation de ressource GPU (AcceleratorAllocation) restée active en base de données alors qu'aucune réservation en cours ne la justifie - typiquement après l'arrêt inattendu d'une session.",
    severity: 'WARNING',
    impact: "Le GPU concerné reste marqué occupé et ne peut pas être re-publié tant que l'incohérence n'est pas corrigée.",
    triggerConditions: "Le diagnostic (ou detectAvailableRepair) trouve une AcceleratorAllocation au statut HELD/CONFIRMED/ACTIVE liée à une réservation déjà COMPLETED ou CANCELLED.",
    evidenceRequired: "AcceleratorAllocation.status + Booking.status correspondant, visibles dans le check 'allocation' du diagnostic.",
    recommendedAction: "Cliquez sur « Réparer automatiquement » (nettoyage de la seule ligne de comptabilité interne, aucun processus réel n'est touché), puis relancez un diagnostic pour confirmer.",
    diagnosticRequired: true,
    repairPossible: true,
    autoExitPossible: true,
  },
  GPU_UNAVAILABLE: {
    code: 'GPU_UNAVAILABLE',
    title: 'Aucun GPU détecté',
    description: "Le dernier diagnostic ou heartbeat de l'agent ne rapporte aucun accélérateur GPU disponible.",
    severity: 'CRITICAL',
    impact: 'Aucune location ni Workspace ne peut démarrer sans GPU détecté.',
    triggerConditions: "Le diagnostic rapporte gpuDetected=false, ou aucun accélérateur présent n'est rapporté.",
    evidenceRequired: "Check 'gpu' du DiagnosticRun le plus récent, statut FAIL ou UNKNOWN.",
    recommendedAction: "Vérifiez le branchement et la détection du GPU sur la machine (nvidia-smi), puis relancez un diagnostic.",
    diagnosticRequired: true,
    repairPossible: false,
    autoExitPossible: true,
  },
  DOCKER_UNAVAILABLE: {
    code: 'DOCKER_UNAVAILABLE',
    title: 'Docker indisponible sur la machine',
    description: "Le dernier diagnostic ou heartbeat de l'agent indique que Docker n'est pas accessible sur cette machine.",
    severity: 'CRITICAL',
    impact: 'Aucun Workspace ni tâche ne peut être exécuté sans Docker fonctionnel.',
    triggerConditions: 'dockerAvailable=false dans le dernier heartbeat ou diagnostic.',
    evidenceRequired: "Champ dockerAvailable du dernier heartbeat, et check 'docker' du diagnostic.",
    recommendedAction: "Démarrez le service Docker sur la machine, puis relancez un diagnostic.",
    diagnosticRequired: true,
    repairPossible: false,
    autoExitPossible: true,
  },
  NVIDIA_RUNTIME_UNAVAILABLE: {
    code: 'NVIDIA_RUNTIME_UNAVAILABLE',
    title: 'Runtime conteneur NVIDIA indisponible',
    description: "Le dernier diagnostic ou heartbeat indique que le runtime conteneur NVIDIA (nvidia-container-toolkit) n'est pas fonctionnel.",
    severity: 'CRITICAL',
    impact: 'Aucun conteneur ne peut accéder au GPU sans ce runtime.',
    triggerConditions: 'nvidiaRuntimeAvailable=false dans le dernier heartbeat ou diagnostic.',
    evidenceRequired: "Champ nvidiaRuntimeAvailable du dernier heartbeat, et check 'nvidiaRuntime' du diagnostic.",
    recommendedAction: "Réinstallez/vérifiez le NVIDIA Container Toolkit sur la machine, puis relancez un diagnostic.",
    diagnosticRequired: true,
    repairPossible: false,
    autoExitPossible: true,
  },
  UNKNOWN: {
    code: 'UNKNOWN',
    title: 'Cause historique non déterminable',
    description:
      "Cette machine a été mise en quarantaine avant la mise en place du suivi détaillé des causes, ou par un mécanisme dont la preuve n'a pas survécu (compteur de sécurité expiré, par exemple).",
    severity: 'WARNING',
    impact: 'La machine reste bloquée par précaution jusqu’à un diagnostic réel (publication et réservation impossibles).',
    triggerConditions: 'Repli utilisé uniquement quand aucun code plus précis ne peut être établi.',
    evidenceRequired: "Aucune - c'est précisément l'absence de preuve exploitable qui place une quarantaine dans ce code. Ne jamais inventer une cause plus précise que celle réellement prouvée.",
    recommendedAction: "Lancez un nouveau diagnostic : c'est la nouvelle preuve qui déterminera si la machine est réellement saine aujourd'hui, indépendamment de la cause historique.",
    diagnosticRequired: true,
    repairPossible: false,
    autoExitPossible: true,
  },
};

export function reasonDefinition(code: QuarantineReasonCode): QuarantineReasonDefinition {
  return QUARANTINE_REASON_REGISTRY[code] ?? QUARANTINE_REASON_REGISTRY.UNKNOWN;
}
