import { QuarantineReasonCode } from '@prisma/client';

export type ReasonSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export type QuarantineReasonDefinition = {
  code: QuarantineReasonCode;
  title: string;
  description: string;
  severity: ReasonSeverity;
  impact: string;
  triggerConditions: string;
  /** Whether a successful re-diagnostic can ever clear this reason on its own,
   * vs. requiring the owner/agent to change something first (still gated by a
   * real diagnostic either way - this only documents intent for the UI). */
  autoRecoverable: boolean;
};

/**
 * Single source of truth for every quarantine reason code the platform can
 * assign. The code itself is what other code may branch on; title/description
 * are what a human sees in Host. Never invent a free-text reason where a code
 * from this table applies - add a new code here instead of a raw string.
 */
export const QUARANTINE_REASON_REGISTRY: Record<QuarantineReasonCode, QuarantineReasonDefinition> = {
  CRITICAL_GPU_IDENTITY_CHANGE: {
    code: 'CRITICAL_GPU_IDENTITY_CHANGE',
    title: "Changement critique d'identité GPU pendant une session",
    description:
      "Le matériel GPU rapporté par l'agent a changé de façon critique (accélérateur retiré ou identité modifiée) alors qu'une session de location était active.",
    severity: 'CRITICAL',
    impact: "Toutes les annonces de cette machine sont masquées, les sessions actives sont arrêtées et les paiements en cours sont gelés en attente de vérification.",
    triggerConditions: "Une session est active sur la machine ET l'agent rapporte un accélérateur disparu ou dont l'identité matérielle a changé depuis la dernière vérification.",
    autoRecoverable: true,
  },
  DIAGNOSTIC_COMPLETION_RACE: {
    code: 'DIAGNOSTIC_COMPLETION_RACE',
    title: 'Session Developer active après libération de la ressource GPU',
    description:
      "La réservation associée à cette session Developer s'est terminée alors que la ressource GPU allouée avait déjà été libérée ailleurs, créant un état incohérent.",
    severity: 'CRITICAL',
    impact: 'La session concernée est arrêtée de force et le paiement est mis en attente de règlement manuel.',
    triggerConditions: "Une session Developer reste active/en préparation alors que sa réservation est déjà COMPLETED et que la ressource GPU associée a été réattribuée.",
    autoRecoverable: true,
  },
  STALE_CLAIM: {
    code: 'STALE_CLAIM',
    title: 'Revendication de ressource GPU non prouvée',
    description:
      "L'agent n'a pas pu prouver que le GPU était réellement libre (quiescence) avant de démarrer une nouvelle location, ou une revendication précédente est restée bloquée sans preuve.",
    severity: 'CRITICAL',
    impact: 'La ressource GPU concernée reste verrouillée localement par l’agent tant qu’une nouvelle preuve de quiescence n’est pas apportée.',
    triggerConditions: "Le superviseur de préemption GPU de l'agent (gpu_rental_preemption.py) ne peut pas prouver l'état QUIESCENT d'une ressource avant de l'attribuer à une nouvelle session.",
    autoRecoverable: true,
  },
  STALE_JOB: {
    code: 'STALE_JOB',
    title: 'Tâche agent restée bloquée sans confirmation de nettoyage',
    description:
      "Une tâche (diagnostic, préparation de Workspace, etc.) est restée assignée à l'agent au-delà du délai attendu, sans qu'aucune confirmation de nettoyage n'ait été reçue.",
    severity: 'CRITICAL',
    impact: "Comme l'API ne peut pas prouver que la tâche a été proprement nettoyée côté agent, la machine est bloquée par sécurité plutôt que remise disponible sans preuve.",
    triggerConditions: 'Une tâche déjà réclamée par un agent (ASSIGNED/DOWNLOADING/PREPARING/RUNNING/UPLOADING_RESULTS) dépasse son bail (lease) sans renouvellement.',
    autoRecoverable: true,
  },
  WORKSPACE_CLEANUP_FAILED: {
    code: 'WORKSPACE_CLEANUP_FAILED',
    title: "Fin de session Workspace sans confirmation de nettoyage",
    description:
      "L'agent a signalé la fin d'une session Workspace interactive (Developer, Cloud Desktop, etc.) sans confirmer que l'environnement isolé avait été correctement nettoyé.",
    severity: 'CRITICAL',
    impact: "La machine est bloquée jusqu'à preuve qu'aucune donnée ni processus du précédent locataire ne subsiste.",
    triggerConditions: "POST /agent/workspace-gateway/:sessionId/stopped est reçu avec cleaned !== true.",
    autoRecoverable: true,
  },
  AGENT_SECURITY_FAILURE: {
    code: 'AGENT_SECURITY_FAILURE',
    title: 'Échecs de signature agent répétés',
    description:
      "Plusieurs requêtes signées de cet agent n'ont pas pu être vérifiées cryptographiquement en quelques minutes, ce qui peut indiquer une clé compromise, une horloge désynchronisée ou une tentative de contrefaçon.",
    severity: 'CRITICAL',
    impact: 'La machine est mise hors ligne et bloquée par précaution de sécurité.',
    triggerConditions: '8 échecs de vérification de signature ou plus pour cette machine en moins de 15 minutes.',
    autoRecoverable: true,
  },
  GPU_HEALTH_CHECK_FAILED: {
    code: 'GPU_HEALTH_CHECK_FAILED',
    title: 'Le diagnostic GPU a échoué',
    description: "Le dernier diagnostic réel exécuté par l'agent sur cette machine n'a pas confirmé un GPU sain et utilisable.",
    severity: 'CRITICAL',
    impact: 'La machine ne peut pas être publiée ni louée tant que ce diagnostic ne repasse pas au vert.',
    triggerConditions: "Un DiagnosticRun se termine avec le check 'gpu' à FAIL ou UNKNOWN.",
    autoRecoverable: true,
  },
  GPU_UNAVAILABLE: {
    code: 'GPU_UNAVAILABLE',
    title: 'Aucun GPU détecté',
    description: "Le dernier diagnostic ou heartbeat de l'agent ne rapporte aucun accélérateur GPU disponible.",
    severity: 'CRITICAL',
    impact: 'Aucune location ni Workspace ne peut démarrer sans GPU détecté.',
    triggerConditions: "Le diagnostic rapporte gpuDetected=false, ou aucun accélérateur présent n'est rapporté.",
    autoRecoverable: true,
  },
  DOCKER_UNAVAILABLE: {
    code: 'DOCKER_UNAVAILABLE',
    title: 'Docker indisponible sur la machine',
    description: "Le dernier diagnostic ou heartbeat de l'agent indique que Docker n'est pas accessible sur cette machine.",
    severity: 'CRITICAL',
    impact: 'Aucun Workspace ni tâche ne peut être exécuté sans Docker fonctionnel.',
    triggerConditions: 'dockerAvailable=false dans le dernier heartbeat ou diagnostic.',
    autoRecoverable: true,
  },
  NVIDIA_RUNTIME_UNAVAILABLE: {
    code: 'NVIDIA_RUNTIME_UNAVAILABLE',
    title: 'Runtime conteneur NVIDIA indisponible',
    description: "Le dernier diagnostic ou heartbeat indique que le runtime conteneur NVIDIA (nvidia-container-toolkit) n'est pas fonctionnel.",
    severity: 'CRITICAL',
    impact: 'Aucun conteneur ne peut accéder au GPU sans ce runtime.',
    triggerConditions: 'nvidiaRuntimeAvailable=false dans le dernier heartbeat ou diagnostic.',
    autoRecoverable: true,
  },
  UNKNOWN: {
    code: 'UNKNOWN',
    title: 'Cause historique non déterminable',
    description:
      "Cette machine a été mise en quarantaine avant la mise en place du suivi détaillé des causes, ou par un mécanisme dont la preuve n'a pas survécu (compteur de sécurité expiré, par exemple).",
    severity: 'WARNING',
    impact: 'La machine reste bloquée par précaution jusqu’à un diagnostic réel.',
    triggerConditions: 'Repli utilisé uniquement quand aucun code plus précis ne peut être établi.',
    autoRecoverable: true,
  },
};

export function reasonDefinition(code: QuarantineReasonCode): QuarantineReasonDefinition {
  return QUARANTINE_REASON_REGISTRY[code] ?? QUARANTINE_REASON_REGISTRY.UNKNOWN;
}
