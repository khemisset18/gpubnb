import { invoke } from '@tauri-apps/api/core';
import { completeIntroduction, readOnboardingState } from './onboarding-state';
import './styles.css';
import './pairing.css';

type Lifecycle = 'setup_required' | 'ready' | 'online' | 'emergency_stopped';
type Check = { id: string; label: string; ok: boolean; detail: string; actionLabel?: string | null };
type PairingConfiguration = { configured: boolean; browserUrl?: string | null; storesPassword: boolean; explanation: string };
type AgentStatus = { installed: boolean; linked: boolean; running: boolean; machineId?: string | null; detail: string };
type GpuDevice = { index: number; uuid: string; model: string; driverVersion: string; vramMib: number };
type NativeDiagnostic = { canHost: boolean; reason: string; gpus: GpuDevice[] };
type HostStatus = {
  platform: string; architecture: string; ready: boolean; lifecycle: Lifecycle; progress: number;
  blockingCount: number; summary: string; nextActionId?: string | null; pairing: PairingConfiguration;
  agent: AgentStatus; diagnostic: NativeDiagnostic; checks: Check[];
};

const TRUSTED_WEB_ORIGIN = 'https://gpubnb.netlify.app';
const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('missing_app_root');
const app = root;
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char] ?? char);
const lifecycleLabel = (lifecycle: Lifecycle): string => ({ setup_required: 'Configuration', ready: 'Prêt', online: 'En ligne', emergency_stopped: 'Arrêté' })[lifecycle];
const formatVram = (mib: number): string => `${Math.round((mib / 1024) * 10) / 10} Go`;

const trustedWebUrl = (candidate: string): URL | null => {
  try {
    const url = new URL(candidate);
    return url.origin === TRUSTED_WEB_ORIGIN && url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

const diagnosticMessage = (reason: string): string => ({
  operating_system_not_supported: 'Ce système d’exploitation n’est pas encore pris en charge.',
  architecture_not_supported: 'L’architecture de ce processeur n’est pas prise en charge.',
  nvidia_gpu_not_detected: 'Aucun GPU NVIDIA compatible n’a été détecté par le pilote.',
  docker_not_installed: 'Docker n’est pas installé sur cet ordinateur.',
  docker_daemon_unreachable: 'Docker est installé, mais son service ne répond pas.',
  nvidia_container_runtime_missing: 'Le runtime NVIDIA pour Docker est absent.',
  hardware_isolation_unavailable: 'La virtualisation matérielle sécurisée est indisponible ou désactivée.',
  native_prerequisites_ready: 'Le matériel et les prérequis natifs sont prêts.',
})[reason] ?? 'Une vérification technique obligatoire a échoué.';

const pairingErrorMessage = (error: unknown): string => {
  const value = String(error);
  if (value.includes('invalid_link_code')) return 'Le code doit contenir exactement 10 caractères hexadécimaux.';
  if (value.includes('agent_not_installed')) return 'Installez d’abord l’agent GPUbnb sur cet ordinateur.';
  if (value.includes('agent_link_not_persisted')) return 'La liaison n’a pas été sauvegardée par l’agent local.';
  if (value.includes('agent_link_failed')) return 'Le code a été refusé, a expiré ou a déjà été utilisé.';
  return 'La liaison n’a pas abouti. La machine reste hors ligne.';
};

const setMessage = (message: string, tone: 'info' | 'success' | 'error' = 'info'): void => {
  const node = document.querySelector<HTMLElement>('#action-status');
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
};

const setOpenLinkMessage = (url: URL, label: string): void => {
  const node = document.querySelector<HTMLElement>('#action-status');
  if (!node) return;
  node.dataset.tone = 'error';
  node.replaceChildren(document.createTextNode('Le navigateur n’a pas pu s’ouvrir automatiquement. '));
  const link = document.createElement('a');
  link.href = url.toString();
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'safe-external-link';
  link.textContent = label;
  node.append(link);
};

const openTrustedUrl = (url: URL, successMessage: string, fallbackLabel: string): void => {
  if (url.origin !== TRUSTED_WEB_ORIGIN || url.protocol !== 'https:') {
    setMessage('Adresse externe refusée pour protéger votre compte.', 'error');
    return;
  }
  const opened = window.open(url.toString(), '_blank', 'noopener,noreferrer');
  if (opened) setMessage(successMessage, 'success');
  else setOpenLinkMessage(url, fallbackLabel);
};

const renderChecks = (status: HostStatus): string => status.checks.map((check) => {
  const detail = check.id === 'platform' && !check.ok ? diagnosticMessage(status.diagnostic.reason) : check.detail;
  return `<li class="check ${check.ok ? 'ok' : 'blocked'}">
    <span class="check-icon" aria-hidden="true">${check.ok ? '✓' : '!'}</span>
    <div class="check-copy"><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(detail)}</small></div>
    ${!check.ok && check.actionLabel ? `<button class="secondary" data-action="${escapeHtml(check.id)}">${escapeHtml(check.actionLabel)}</button>` : ''}
  </li>`;
}).join('');

const renderPairing = (status: HostStatus): string => {
  if (status.agent.linked && status.agent.machineId) return `<section class="explanation pairing-guide">
    <p class="eyebrow">Machine associée</p><h2>Ce Host est relié à votre compte</h2><p>${escapeHtml(status.agent.detail)}</p>
    <div class="machine-identity"><span>Identifiant machine</span><code>${escapeHtml(status.agent.machineId)}</code></div></section>`;
  return `<section class="explanation pairing-guide"><p class="eyebrow">Connexion sécurisée</p><h2>Reliez cet ordinateur à votre compte</h2>
    <p>${status.pairing.configured ? 'Connectez-vous sur le site GPUbnb, générez un code temporaire puis saisissez-le ci-dessous.' : 'Le service officiel de liaison n’est pas configuré dans cette version.'}</p>
    ${status.pairing.configured ? `<form id="pairing-form" class="pairing-form" novalidate><label for="pairing-code">Code de liaison</label><div class="pairing-controls">
      <input id="pairing-code" autocomplete="one-time-code" maxlength="10" pattern="[A-Fa-f0-9]{10}" placeholder="A1B2C3D4E5" required>
      <button id="pairing-submit" class="primary large" type="submit">Relier cette machine</button></div><small>Le code est transmis directement à l’agent local et n’est jamais enregistré dans l’interface.</small></form>` : ''}
    <p>${escapeHtml(status.pairing.explanation)}</p></section>`;
};

const renderGpuInventory = (status: HostStatus): string => {
  const gpus = status.diagnostic.gpus ?? [];
  if (gpus.length === 0) return `<section class="gpu-inventory"><p class="eyebrow">Matériel détecté</p><h2>Aucun GPU NVIDIA détecté</h2><p>${escapeHtml(diagnosticMessage(status.diagnostic.reason))}</p></section>`;
  return `<section class="gpu-inventory"><div class="inventory-heading"><div><p class="eyebrow">Matériel détecté automatiquement</p><h2>${gpus.length} GPU ${gpus.length > 1 ? 'détectés' : 'détecté'}</h2></div><span class="badge">Données non modifiables</span></div>
    <div class="gpu-grid">${gpus.map((gpu) => `<article class="gpu-card"><div><span class="gpu-index">GPU ${gpu.index}</span><h3>${escapeHtml(gpu.model)}</h3></div>
      <dl><div><dt>Mémoire</dt><dd>${formatVram(gpu.vramMib)}</dd></div><div><dt>Pilote</dt><dd>${escapeHtml(gpu.driverVersion)}</dd></div></dl>
      <code title="${escapeHtml(gpu.uuid)}">${escapeHtml(gpu.uuid)}</code>
      <button class="primary create-listing" data-gpu-uuid="${escapeHtml(gpu.uuid)}" ${status.agent.linked && status.agent.machineId && status.pairing.browserUrl ? '' : 'disabled'}>Nouvelle annonce</button>
    </article>`).join('')}</div></section>`;
};

const listingUrl = (baseUrl: string, machineId: string, gpuUuid: string): URL | null => {
  const url = trustedWebUrl(baseUrl);
  if (!url || !/^machine_[A-Za-z0-9_-]{1,96}$/.test(machineId) || !/^GPU-[A-Za-z0-9_-]{1,124}$/.test(gpuUuid)) return null;
  url.pathname = '/host/listings/new';
  url.search = '';
  url.hash = '';
  url.searchParams.set('machineId', machineId);
  url.searchParams.set('gpuUuid', gpuUuid);
  url.searchParams.set('source', 'host-desktop');
  return url;
};

const bindPairing = (): void => {
  const input = document.querySelector<HTMLInputElement>('#pairing-code');
  input?.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 10); input.setCustomValidity(''); });
  document.querySelector<HTMLFormElement>('#pairing-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const button = document.querySelector<HTMLButtonElement>('#pairing-submit');
    const code = input?.value.trim().toUpperCase() ?? '';
    if (!/^[A-F0-9]{10}$/.test(code)) { input?.setCustomValidity('Code invalide'); input?.reportValidity(); setMessage('Le code doit contenir exactement 10 caractères hexadécimaux.', 'error'); return; }
    if (button) { button.disabled = true; button.textContent = 'Liaison…'; }
    setMessage('Association de la machine en cours…');
    void invoke<AgentStatus>('link_local_agent', { code }).then((agent) => {
      if (!agent.linked || !agent.machineId) throw new Error('agent_link_not_persisted');
      setMessage(`Machine associée : ${agent.machineId}`, 'success'); window.setTimeout(() => void refresh(), 400);
    }).catch((error: unknown) => setMessage(pairingErrorMessage(error), 'error')).finally(() => { if (button) { button.disabled = false; button.textContent = 'Relier cette machine'; } });
  });
};

const bindActions = (status: HostStatus): void => {
  document.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => void refresh());
  document.querySelector<HTMLButtonElement>('#publish')?.addEventListener('click', () => { void invoke('request_publish').then(() => void refresh()).catch(() => setMessage('Activation refusée : une protection obligatoire manque.', 'error')); });
  document.querySelectorAll<HTMLButtonElement>('.create-listing').forEach((button) => button.addEventListener('click', () => {
    const gpuUuid = button.dataset.gpuUuid;
    const machineId = status.agent.machineId;
    const baseUrl = status.pairing.browserUrl;
    if (!gpuUuid || !machineId || !baseUrl) { setMessage('Connectez d’abord cette machine à votre compte.', 'error'); return; }
    const target = listingUrl(baseUrl, machineId, gpuUuid);
    if (!target) { setMessage('Les identifiants matériels ou l’adresse GPUbnb sont invalides.', 'error'); return; }
    openTrustedUrl(target, 'Annonce préremplie ouverte sur GPUbnb.', 'Ouvrir la nouvelle annonce');
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => button.addEventListener('click', () => {
    const actionId = button.dataset.action;
    if (!actionId) return;
    if (actionId === 'account' && status.pairing.browserUrl) {
      const target = trustedWebUrl(status.pairing.browserUrl);
      if (!target) { setMessage('L’adresse de connexion a été refusée pour protéger votre compte.', 'error'); return; }
      openTrustedUrl(target, 'Le site GPUbnb a été ouvert.', 'Ouvrir la connexion GPUbnb');
      return;
    }
    void invoke<string>('run_setup_action', { actionId }).then(() => setMessage('Action préparée.', 'success')).catch(() => setMessage('Cette action a été bloquée pour protéger votre ordinateur.', 'error'));
  }));
};

async function refresh(): Promise<void> {
  app.innerHTML = '<main class="loading"><div class="spinner"></div><p>Vérification sécurisée de votre ordinateur…</p></main>';
  try {
    const status = await invoke<HostStatus>('host_status');
    const progress = Math.round(Math.min(100, Math.max(0, status.progress)));
    const online = status.lifecycle === 'online'; const stopped = status.lifecycle === 'emergency_stopped';
    app.innerHTML = `<main class="layout"><aside class="sidebar"><div class="brand"><span class="brand-mark">G</span><div><strong>GPUbnb Host</strong><small>Hôte sécurisé</small></div></div></aside>
      <section class="content"><header class="topbar"><div><p class="eyebrow">GPUbnb Host</p><h1>${online ? 'Votre machine est disponible.' : 'Préparez cet ordinateur.'}</h1></div>
      <div class="status-stack"><span class="status-pill ${status.lifecycle}">${lifecycleLabel(status.lifecycle)}</span><span class="badge">${escapeHtml(status.platform)} · ${escapeHtml(status.architecture)}</span></div></header>
      ${stopped ? '<section class="alert-card danger"><strong>Arrêt d’urgence actif</strong></section>' : ''}
      <section class="progress-card"><div class="progress-heading"><div><p class="eyebrow">État de préparation</p><h2>${escapeHtml(status.summary)}</h2></div><strong>${progress}%</strong></div><div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div></section>
      ${renderPairing(status)}${renderGpuInventory(status)}<p id="action-status" class="action-status" aria-live="polite"></p><ul class="checks">${renderChecks(status)}</ul>
      <div class="actions"><button id="refresh" class="secondary large">Revérifier</button><button id="publish" class="primary large" ${status.ready && !stopped && !online ? '' : 'disabled'}>${online ? 'Machine déjà en ligne' : 'Mettre en ligne'}</button></div></section></main>`;
    bindPairing(); bindActions(status);
  } catch (error: unknown) {
    app.innerHTML = `<main class="error-state"><h1>Votre ordinateur reste protégé.</h1><p>${escapeHtml(String(error))}</p><button id="retry" class="primary large">Relancer</button></main>`;
    document.querySelector<HTMLButtonElement>('#retry')?.addEventListener('click', () => void refresh());
  }
}

if (readOnboardingState().introductionCompleted) void refresh();
else {
  app.innerHTML = '<main class="welcome-shell"><section class="welcome-card"><div class="brand"><span class="brand-mark">G</span><strong>GPUbnb Host</strong></div><h1>Préparons votre ordinateur.</h1><p>La configuration reste bloquée tant qu’une protection obligatoire manque.</p><button id="start-onboarding" class="primary large">Commencer</button></section></main>';
  document.querySelector<HTMLButtonElement>('#start-onboarding')?.addEventListener('click', () => { completeIntroduction(); void refresh(); });
}
