import { invoke } from '@tauri-apps/api/core';
import { completeIntroduction, readOnboardingState } from './onboarding-state';
import './styles.css';
import './pairing.css';

type Lifecycle = 'setup_required' | 'ready' | 'online' | 'emergency_stopped';

type Check = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  actionLabel?: string | null;
};

type PairingConfiguration = {
  configured: boolean;
  browserUrl?: string | null;
  storesPassword: boolean;
  explanation: string;
};

type AgentStatus = {
  installed: boolean;
  linked: boolean;
  running: boolean;
  machineId?: string | null;
  detail: string;
};

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
  checks: Check[];
};

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

const renderChecks = (checks: Check[]): string => checks.map((check) => `
  <li class="check ${check.ok ? 'ok' : 'blocked'}">
    <span class="check-icon" aria-hidden="true">${check.ok ? '✓' : '!'}</span>
    <div class="check-copy"><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></div>
    ${!check.ok && check.actionLabel ? `<button class="secondary" data-action="${escapeHtml(check.id)}">${escapeHtml(check.actionLabel)}</button>` : ''}
  </li>`).join('');

const renderPairing = (status: HostStatus): string => {
  if (status.agent.linked && status.agent.machineId) {
    return `<section class="explanation pairing-guide">
      <p class="eyebrow">Machine associée</p><h2>Ce Host est relié à votre compte</h2>
      <p>${escapeHtml(status.agent.detail)}</p>
      <div class="machine-identity"><span>Identifiant machine</span><code>${escapeHtml(status.agent.machineId)}</code></div>
    </section>`;
  }

  return `<section class="explanation pairing-guide">
    <p class="eyebrow">Connexion sécurisée</p><h2>Reliez cet ordinateur à votre compte</h2>
    <p>${status.pairing.configured
      ? 'Connectez-vous sur le site GPUbnb, générez un code temporaire puis saisissez-le ci-dessous.'
      : 'Le service officiel de liaison n’est pas configuré dans cette version.'}</p>
    ${status.pairing.configured ? `<form id="pairing-form" class="pairing-form" novalidate>
      <label for="pairing-code">Code de liaison</label>
      <div class="pairing-controls">
        <input id="pairing-code" autocomplete="one-time-code" maxlength="10" pattern="[A-Fa-f0-9]{10}" placeholder="A1B2C3D4E5" required>
        <button id="pairing-submit" class="primary large" type="submit">Relier cette machine</button>
      </div>
      <small>Le code est transmis directement à l’agent local et n’est pas conservé par l’interface.</small>
    </form>` : ''}
    <p>${escapeHtml(status.pairing.explanation)}</p>
  </section>`;
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
    setMessage('Association de la machine en cours…');

    void invoke<AgentStatus>('link_local_agent', { code })
      .then((agent) => {
        if (!agent.linked || !agent.machineId) throw new Error('agent_link_not_persisted');
        setMessage(`Machine associée : ${agent.machineId}`, 'success');
        window.setTimeout(() => void refresh(), 400);
      })
      .catch((error: unknown) => setMessage(pairingErrorMessage(error), 'error'))
      .finally(() => {
        if (button) {
          button.disabled = false;
          button.textContent = 'Relier cette machine';
        }
      });
  });
};

const bindActions = (status: HostStatus): void => {
  document.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => void refresh());
  document.querySelector<HTMLButtonElement>('#publish')?.addEventListener('click', () => {
    void invoke('request_publish')
      .then(() => void refresh())
      .catch(() => setMessage('Activation refusée : une protection obligatoire manque.', 'error'));
  });

  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const actionId = button.dataset.action;
      if (!actionId) return;
      if (actionId === 'account' && status.pairing.browserUrl) {
        const opened = window.open(status.pairing.browserUrl, '_blank', 'noopener,noreferrer');
        setMessage(opened ? 'Le site GPUbnb a été ouvert.' : `Ouvrez cette adresse : ${status.pairing.browserUrl}`, opened ? 'success' : 'error');
        return;
      }
      void invoke<string>('run_setup_action', { actionId })
        .then(() => setMessage('Action préparée.', 'success'))
        .catch(() => setMessage('Cette action a été bloquée pour protéger votre ordinateur.', 'error'));
    });
  });
};

async function refresh(): Promise<void> {
  app.innerHTML = '<main class="loading"><div class="spinner"></div><p>Vérification sécurisée de votre ordinateur…</p></main>';
  try {
    const status = await invoke<HostStatus>('host_status');
    const progress = Math.round(Math.min(100, Math.max(0, status.progress)));
    const online = status.lifecycle === 'online';
    const stopped = status.lifecycle === 'emergency_stopped';
    app.innerHTML = `<main class="layout">
      <aside class="sidebar"><div class="brand"><span class="brand-mark">G</span><div><strong>GPUbnb Host</strong><small>Hôte sécurisé</small></div></div></aside>
      <section class="content">
        <header class="topbar"><div><p class="eyebrow">GPUbnb Host</p><h1>${online ? 'Votre GPU est disponible.' : 'Préparez cet ordinateur.'}</h1></div>
          <div class="status-stack"><span class="status-pill ${status.lifecycle}">${lifecycleLabel(status.lifecycle)}</span><span class="badge">${escapeHtml(status.platform)} · ${escapeHtml(status.architecture)}</span></div></header>
        ${stopped ? '<section class="alert-card danger"><strong>Arrêt d’urgence actif</strong></section>' : ''}
        <section class="progress-card"><div class="progress-heading"><div><p class="eyebrow">État de préparation</p><h2>${escapeHtml(status.summary)}</h2></div><strong>${progress}%</strong></div>
          <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div></section>
        ${renderPairing(status)}
        <p id="action-status" class="action-status" aria-live="polite"></p>
        <ul class="checks">${renderChecks(status.checks)}</ul>
        <div class="actions"><button id="refresh" class="secondary large">Revérifier</button>
          <button id="publish" class="primary large" ${status.ready && !stopped && !online ? '' : 'disabled'}>${online ? 'GPU déjà en ligne' : 'Mettre en ligne'}</button></div>
      </section>
    </main>`;
    bindPairing();
    bindActions(status);
  } catch (error: unknown) {
    app.innerHTML = `<main class="error-state"><h1>Votre ordinateur reste protégé.</h1><p>${escapeHtml(String(error))}</p><button id="retry" class="primary large">Relancer</button></main>`;
    document.querySelector<HTMLButtonElement>('#retry')?.addEventListener('click', () => void refresh());
  }
}

if (readOnboardingState().introductionCompleted) {
  void refresh();
} else {
  app.innerHTML = '<main class="welcome-shell"><section class="welcome-card"><div class="brand"><span class="brand-mark">G</span><strong>GPUbnb Host</strong></div><h1>Préparons votre ordinateur.</h1><p>La configuration reste bloquée tant qu’une protection obligatoire manque.</p><button id="start-onboarding" class="primary large">Commencer</button></section></main>';
  document.querySelector<HTMLButtonElement>('#start-onboarding')?.addEventListener('click', () => {
    completeIntroduction();
    void refresh();
  });
}
