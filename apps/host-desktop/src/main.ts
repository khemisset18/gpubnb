import { invoke } from '@tauri-apps/api/core';
import { completeIntroduction, readOnboardingState } from './onboarding-state';
import './styles.css';
import './pairing.css';

type Lifecycle = 'setup_required' | 'ready' | 'online' | 'emergency_stopped';
type Check = { id: string; label: string; ok: boolean; detail: string; actionLabel?: string | null };
type PairingConfiguration = { configured: boolean; browserUrl?: string | null; storesPassword: boolean; explanation: string };
type AgentStatus = { installed: boolean; linked: boolean; running: boolean; machineId?: string | null; detail: string };
type GpuDevice = { index: number; uuid: string; model: string; driverVersion: string; vramMib: number };
type NativeDiagnostic = { canHost: boolean; reason: string; gpus?: GpuDevice[] };
type HostStatus = {
  platform: string;
  architecture: string;
  ready: boolean;
  lifecycle: Lifecycle;
  progress: number;
  blockingCount: number;
  summary: string;
  nextActionId?: string | null;
  pairing: PairingConfiguration;
  agent: AgentStatus;
  diagnostic: NativeDiagnostic;
  checks: Check[];
};

type MessageTone = 'info' | 'success' | 'error';

const OFFICIAL_ORIGINS = new Set(['https://gpubnb.com', 'https://app.gpubnb.com', 'https://gpubnb.netlify.app']);
const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;
const GPU_UUID_PATTERN = /^GPU-[A-Za-z0-9-]{3,124}$/;

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('missing_app_root');
const app = root;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
})[char] ?? char);

const lifecycleLabel = (lifecycle: Lifecycle): string => ({
  setup_required: 'Configuration',
  ready: 'Prêt',
  online: 'En ligne',
  emergency_stopped: 'Arrêté',
})[lifecycle];

const formatVram = (mib: number): string => `${Math.round((mib / 1024) * 10) / 10} Go`;

const diagnosticDetail = (reason: string): string => ({
  operating_system_not_supported: "Ce système d’exploitation n’est pas pris en charge.",
  architecture_not_supported: "L’architecture du processeur n’est pas prise en charge.",
  nvidia_gpu_not_detected: 'Aucun GPU NVIDIA compatible n’a été détecté.',
  docker_not_installed: 'Docker doit être installé avant la mise en location.',
  docker_daemon_unreachable: 'Docker est installé, mais son service ne répond pas.',
  nvidia_container_runtime_missing: 'Le runtime NVIDIA pour conteneurs est absent.',
  hardware_isolation_unavailable: 'La virtualisation matérielle ou son accès sécurisé est indisponible.',
  native_prerequisites_ready: 'Le matériel et les prérequis techniques sont prêts.',
})[reason] ?? 'Une vérification technique obligatoire a échoué.';

const pairingErrorMessage = (error: unknown): string => {
  const value = String(error);
  if (value.includes('invalid_link_code')) return 'Le code doit contenir exactement 10 caractères hexadécimaux.';
  if (value.includes('agent_not_installed')) return 'Le service GPUbnb n’est pas présent dans cette version. Réinstallez le paquet Windows complet.';
  if (value.includes('agent_setup_required')) return 'Préparation locale requise : installez le service GPUbnb, puis réessayez.';
  if (value.includes('agent_not_linked')) return 'Cette machine doit d’abord être reliée avec un code GPUbnb valide.';
  if (value.includes('agent_link_not_persisted')) return 'La liaison n’a pas été sauvegardée par le service local.';
  if (value.includes('agent_key_already_registered')) return 'Cette clé agent est déjà reliée à un autre compte. Réinitialisez la clé puis recréez un code.';
  if (value.includes('agent_link_failed')) return 'Le code a été refusé, a expiré ou a déjà été utilisé.';
  if (value.includes('storage_protection_not_implemented')) return 'Le stockage locataire isolé n’est pas encore provisionné. La mise en ligne reste bloquée.';
  if (value.includes('network_filter_not_implemented')) return 'Le filtrage réseau locataire n’est pas encore provisionné. La mise en ligne reste bloquée.';
  if (value.includes('agent_command_failed')) return 'Le service GPUbnb n’a pas pu exécuter la commande demandée.';
  return 'La liaison ou la configuration n’a pas abouti. La machine reste hors ligne.';
};

const setMessage = (message: string, tone: MessageTone = 'info', fallbackUrl?: string): void => {
  const node = document.querySelector<HTMLElement>('#action-status');
  if (!node) return;
  node.dataset.tone = tone;
  node.replaceChildren(document.createTextNode(message));

  if (fallbackUrl) {
    const link = document.createElement('a');
    link.className = 'fallback-link';
    link.href = fallbackUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Ouvrir dans le navigateur';
    node.append(document.createTextNode(' '), link);
  }
};

const officialUrl = (rawUrl: string): URL | null => {
  try {
    const url = new URL(rawUrl);
    if (!OFFICIAL_ORIGINS.has(url.origin) || url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
};

const openOfficialUrl = (url: URL, successMessage: string): void => {
  const href = url.toString();
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.hidden = true;
  document.body.append(link);

  try {
    link.click();
    setMessage(`${successMessage} Si rien ne s’ouvre, utilisez le lien suivant.`, 'success', href);
  } catch {
    setMessage("Le navigateur n’a pas pu s’ouvrir automatiquement.", 'error', href);
  } finally {
    link.remove();
  }
};

const listingUrl = (baseUrl: string, machineId: string, gpuUuid: string): URL | null => {
  if (!MACHINE_ID_PATTERN.test(machineId) || !GPU_UUID_PATTERN.test(gpuUuid)) return null;
  const url = officialUrl(baseUrl);
  if (!url) return null;
  url.pathname = '/host/listings/new';
  url.search = '';
  url.searchParams.set('machineId', machineId);
  url.searchParams.set('gpuUuid', gpuUuid);
  url.searchParams.set('source', 'host-desktop');
  return url;
};

const renderChecks = (checks: Check[]): string => checks.map((check) => `
  <li class="check ${check.ok ? 'ok' : 'blocked'}">
    <span class="check-icon" aria-hidden="true">${check.ok ? '✓' : '!'}</span>
    <div class="check-copy"><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></div>
    ${!check.ok && check.actionLabel ? `<button class="secondary" data-action="${escapeHtml(check.id)}">${escapeHtml(check.actionLabel)}</button>` : ''}
  </li>`).join('');

const renderPairing = (status: HostStatus): string => {
  if (status.agent.linked && status.agent.machineId) return `<section class="explanation pairing-guide">
    <p class="eyebrow">Machine associée</p><h2>Ce Host est relié à votre compte</h2><p>${escapeHtml(status.agent.detail)}</p>
    <div class="machine-identity"><span>Identifiant machine</span><code>${escapeHtml(status.agent.machineId)}</code></div></section>`;

  return `<section class="explanation pairing-guide"><p class="eyebrow">Connexion sécurisée</p><h2>Reliez cet ordinateur à votre compte</h2>
    <p>${status.pairing.configured ? 'Connectez-vous sur GPUbnb, générez un code temporaire puis saisissez-le ci-dessous.' : 'Le service officiel de liaison n’est pas configuré dans cette version.'}</p>
    ${status.pairing.configured ? `<form id="pairing-form" class="pairing-form" novalidate><label for="pairing-code">Code de liaison</label><div class="pairing-controls">
      <input id="pairing-code" autocomplete="one-time-code" inputmode="text" maxlength="10" pattern="[A-Fa-f0-9]{10}" placeholder="A1B2C3D4E5" required>
      <button id="pairing-submit" class="primary large" type="submit">Relier cette machine</button></div><small>Le mot de passe du compte n’est jamais transmis à l’application.</small></form>` : ''}
    <p>${escapeHtml(status.pairing.explanation)}</p></section>`;
};

const renderGpuInventory = (status: HostStatus): string => {
  const gpus = status.diagnostic.gpus ?? [];
  if (gpus.length === 0) return `<section class="gpu-inventory"><p class="eyebrow">Matériel détecté</p><h2>Aucun GPU publié</h2><p>${escapeHtml(diagnosticDetail(status.diagnostic.reason))}</p></section>`;

  const canCreateListing = Boolean(
    status.agent.linked
    && status.agent.machineId
    && MACHINE_ID_PATTERN.test(status.agent.machineId)
    && status.pairing.browserUrl
    && officialUrl(status.pairing.browserUrl),
  );

  return `<section class="gpu-inventory"><div class="inventory-heading"><div><p class="eyebrow">Matériel détecté automatiquement</p><h2>${gpus.length} GPU ${gpus.length > 1 ? 'détectés' : 'détecté'}</h2></div><span class="badge">Données techniques vérifiées</span></div>
    <div class="gpu-grid">${gpus.map((gpu) => {
      const valid = Number.isInteger(gpu.index) && gpu.index >= 0 && GPU_UUID_PATTERN.test(gpu.uuid) && gpu.vramMib > 0;
      return `<article class="gpu-card"><div><span class="gpu-index">GPU ${valid ? gpu.index : '?'}</span><h3>${escapeHtml(gpu.model)}</h3></div>
        <dl><div><dt>Mémoire</dt><dd>${valid ? formatVram(gpu.vramMib) : 'Invalide'}</dd></div><div><dt>Pilote</dt><dd>${escapeHtml(gpu.driverVersion)}</dd></div></dl>
        <code title="${escapeHtml(gpu.uuid)}">${escapeHtml(gpu.uuid)}</code>
        <button class="primary create-listing" data-gpu-uuid="${escapeHtml(gpu.uuid)}" ${canCreateListing && valid ? '' : 'disabled'}>Nouvelle annonce</button>
      </article>`;
    }).join('')}</div></section>`;
};

const bindPairing = (): void => {
  const input = document.querySelector<HTMLInputElement>('#pairing-code');
  input?.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 10);
    input.setCustomValidity('');
  });

  document.querySelector<HTMLFormElement>('#pairing-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const button = document.querySelector<HTMLButtonElement>('#pairing-submit');
    const code = input?.value.trim().toUpperCase() ?? '';
    if (!/^[A-F0-9]{10}$/.test(code)) {
      input?.setCustomValidity('Code invalide');
      input?.reportValidity();
      setMessage('Le code doit contenir exactement 10 caractères hexadécimaux.', 'error');
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Liaison…';
    }
    setMessage('Association sécurisée de la machine en cours…');

    void invoke<AgentStatus>('link_local_agent', { code }).then((agent) => {
      if (!agent.linked || !agent.machineId || !MACHINE_ID_PATTERN.test(agent.machineId)) throw new Error('agent_link_not_persisted');
      setMessage('Machine associée avec succès.', 'success');
      window.setTimeout(() => void refresh(), 400);
    }).catch((error: unknown) => setMessage(pairingErrorMessage(error), 'error')).finally(() => {
      if (button) {
        button.disabled = false;
        button.textContent = 'Relier cette machine';
      }
      if (input) input.value = '';
    });
  });
};

const verifyAgentSetup = async (): Promise<void> => {
  const agent = await invoke<AgentStatus>('local_agent_status');
  if (!agent.installed) throw new Error('agent_not_installed');
  setMessage('Service GPUbnb installé. Créez ou collez maintenant le code de liaison.', 'success');
};

const handleSetupResult = async (result: string): Promise<void> => {
  if (result === 'isolation_verified') {
    setMessage('Isolation matérielle vérifiée.', 'success');
    return;
  }
  if (result === 'agent_setup_completed') {
    await verifyAgentSetup();
    return;
  }
  if (result === 'agent_started') {
    const agent = await invoke<AgentStatus>('local_agent_status');
    if (!agent.running) throw new Error('agent_command_failed');
    setMessage('Service GPUbnb démarré. Vérification en cours…', 'success');
    return;
  }
  if (result === 'open_secure_pairing') {
    setMessage('Ouvrez GPUbnb dans le navigateur pour créer le code.', 'success');
    return;
  }
  throw new Error('agent_command_failed');
};

const bindActions = (status: HostStatus): void => {
  document.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => void refresh());
  document.querySelector<HTMLButtonElement>('#publish')?.addEventListener('click', () => {
    void invoke('request_publish')
      .then(() => void refresh())
      .catch(() => setMessage('Activation refusée : une protection obligatoire manque.', 'error'));
  });

  document.querySelectorAll<HTMLButtonElement>('.create-listing').forEach((button) => button.addEventListener('click', () => {
    const gpuUuid = button.dataset.gpuUuid;
    const machineId = status.agent.machineId;
    const baseUrl = status.pairing.browserUrl;
    if (!gpuUuid || !machineId || !baseUrl) {
      setMessage('Connectez d’abord cette machine à votre compte.', 'error');
      return;
    }
    const target = listingUrl(baseUrl, machineId, gpuUuid);
    if (!target) {
      setMessage('La création a été bloquée car les données de la machine sont invalides.', 'error');
      return;
    }
    openOfficialUrl(target, 'Ouverture de l’annonce préremplie.');
  }));

  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => button.addEventListener('click', () => {
    const actionId = button.dataset.action;
    if (!actionId) return;
    if (actionId === 'account') {
      const target = status.pairing.browserUrl ? officialUrl(status.pairing.browserUrl) : null;
      if (!target) {
        setMessage('L’adresse officielle de connexion est invalide ou absente.', 'error');
        return;
      }
      openOfficialUrl(target, 'Le site officiel GPUbnb a été ouvert.');
      return;
    }
    button.disabled = true;
    void invoke<string>('run_setup_action', { actionId })
      .then((result) => handleSetupResult(result))
      .then(() => window.setTimeout(() => void refresh(), 700))
      .catch((error: unknown) => setMessage(pairingErrorMessage(error), 'error'))
      .finally(() => { button.disabled = false; });
  }));
};

async function refresh(): Promise<void> {
  app.innerHTML = '<main class="loading"><div class="spinner"></div><p>Vérification sécurisée de votre ordinateur…</p></main>';
  try {
    const status = await invoke<HostStatus>('host_status');
    const progress = Math.round(Math.min(100, Math.max(0, status.progress)));
    const online = status.lifecycle === 'online';
    const stopped = status.lifecycle === 'emergency_stopped';
    app.innerHTML = `<main class="layout"><aside class="sidebar"><div class="brand"><span class="brand-mark">G</span><div><strong>GPUbnb Host</strong><small>Hôte sécurisé</small></div></div></aside>
      <section class="content"><header class="topbar"><div><p class="eyebrow">GPUbnb Host</p><h1>${online ? 'Votre machine est disponible.' : 'Préparez cet ordinateur.'}</h1></div>
      <div class="status-stack"><span class="status-pill ${status.lifecycle}">${lifecycleLabel(status.lifecycle)}</span><span class="badge">${escapeHtml(status.platform)} · ${escapeHtml(status.architecture)}</span></div></header>
      ${stopped ? '<section class="alert-card danger"><strong>Arrêt d’urgence actif</strong></section>' : ''}
      <section class="progress-card"><div class="progress-heading"><div><p class="eyebrow">État de préparation</p><h2>${escapeHtml(status.summary)}</h2></div><strong>${progress}%</strong></div><div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div></section>
      ${renderPairing(status)}${renderGpuInventory(status)}<p id="action-status" class="action-status" aria-live="polite"></p><ul class="checks">${renderChecks(status.checks)}</ul>
      <div class="actions"><button id="refresh" class="secondary large">Revérifier</button><button id="publish" class="primary large" ${status.ready && !stopped && !online ? '' : 'disabled'}>${online ? 'Machine déjà en ligne' : 'Mettre en ligne'}</button></div></section></main>`;
    bindPairing();
    bindActions(status);
  } catch (error: unknown) {
    app.innerHTML = `<main class="error-state"><h1>Votre ordinateur reste protégé.</h1><p>${escapeHtml(String(error))}</p><button id="retry" class="primary large">Relancer</button></main>`;
    document.querySelector<HTMLButtonElement>('#retry')?.addEventListener('click', () => void refresh());
  }
}

if (readOnboardingState().introductionCompleted) void refresh();
else {
  app.innerHTML = '<main class="welcome-shell"><section class="welcome-card"><div class="brand"><span class="brand-mark">G</span><strong>GPUbnb Host</strong></div><h1>Préparons votre ordinateur.</h1><p>La configuration reste bloquée tant qu’une protection obligatoire manque.</p><button id="start-onboarding" class="primary large">Commencer</button></section></main>';
  document.querySelector<HTMLButtonElement>('#start-onboarding')?.addEventListener('click', () => {
    completeIntroduction();
    void refresh();
  });
}
