import { invoke } from '@tauri-apps/api/core';
import { completeIntroduction, readOnboardingState } from './onboarding-state';
import { renderResourceAutomation, resourceAutomationView } from './resource-orchestration';
import './styles.css';

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
  checks: Check[];
};

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('missing_app_root');
const app: HTMLElement = root;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
})[char] ?? char);

const lifecycleLabel = (lifecycle: Lifecycle): string => {
  switch (lifecycle) {
    case 'online': return 'En ligne';
    case 'ready': return 'Prêt';
    case 'emergency_stopped': return 'Arrêté';
    default: return 'Configuration';
  }
};

const friendlyActionMessage = (result: string): string => {
  switch (result) {
    case 'open_secure_pairing':
      return 'Le site GPUbnb a été ouvert. Connectez-vous, créez un code de liaison puis revenez dans GPUbnb Host.';
    case 'automatic_setup_pending':
      return 'Configuration préparée. Une confirmation système sera demandée avant toute modification.';
    default:
      return 'Action enregistrée.';
  }
};

const renderCheck = (check: Check, nextActionId?: string | null): string => {
  const isNext = !check.ok && check.id === nextActionId;
  return `
    <li class="check ${check.ok ? 'ok' : 'blocked'} ${isNext ? 'next' : ''}">
      <span class="check-icon" aria-hidden="true">${check.ok ? '✓' : isNext ? '→' : '!'}</span>
      <div class="check-copy">
        <div class="check-title"><strong>${escapeHtml(check.label)}</strong>${isNext ? '<span class="next-label">Prochaine étape</span>' : ''}</div>
        <small>${escapeHtml(check.detail)}</small>
      </div>
      ${!check.ok && check.actionLabel ? `<button class="secondary" data-action="${escapeHtml(check.id)}">${escapeHtml(check.actionLabel)}</button>` : ''}
    </li>`;
};

const setActionStatus = (message: string, tone: 'info' | 'success' | 'error' = 'info'): void => {
  const element = document.querySelector<HTMLElement>('#action-status');
  if (!element) return;
  element.textContent = message;
  element.dataset.tone = tone;
};

const openPairingPage = (pairing: PairingConfiguration): boolean => {
  if (!pairing.configured || !pairing.browserUrl) return false;
  const opened = window.open(pairing.browserUrl, '_blank', 'noopener,noreferrer');
  return opened !== null;
};

const renderPairingGuide = (pairing: PairingConfiguration): string => {
  const serviceMessage = pairing.configured
    ? `<p><strong>1.</strong> Cliquez sur « Connecter mon compte ».<br><strong>2.</strong> Le site officiel GPUbnb s’ouvre dans votre navigateur.<br><strong>3.</strong> Connectez-vous puis créez un code de liaison pour cet ordinateur.</p>`
    : '<p>Le service de connexion officiel n’est pas encore configuré dans cette version. L’application bloque donc l’association au lieu d’utiliser un faux compte.</p>';

  return `
    <section class="explanation pairing-guide" aria-labelledby="pairing-title">
      <div><p class="eyebrow">Connexion simple</p><h2 id="pairing-title">Connectez votre compte sans saisir votre mot de passe ici</h2></div>
      ${serviceMessage}
      <div class="benefits">
        <article><span>01</span><strong>Navigateur sécurisé</strong><p>La connexion s’effectue sur le site GPUbnb, pas dans l’application.</p></article>
        <article><span>02</span><strong>Code temporaire</strong><p>Le code ne sert qu’à associer cet ordinateur une seule fois.</p></article>
        <article><span>03</span><strong>Aucun mot de passe stocké</strong><p>${escapeHtml(pairing.explanation)}</p></article>
      </div>
    </section>`;
};

function renderWelcome(): void {
  app.innerHTML = `
    <main class="welcome-shell">
      <section class="welcome-card" aria-labelledby="welcome-title">
        <div class="brand welcome-brand"><span class="brand-mark">G</span><div><strong>GPUbnb Host</strong><small>Installation guidée</small></div></div>
        <p class="eyebrow">Bienvenue</p>
        <h1 id="welcome-title">Préparons votre ordinateur simplement.</h1>
        <p class="lead">GPUbnb vous accompagne une étape à la fois. Aucun terminal et aucun réglage technique incompréhensible.</p>
        <ul class="promise-list">
          <li><span>✓</span><div><strong>Votre ordinateur reste privé</strong><small>Le bureau, les comptes et les fichiers personnels ne sont jamais partagés.</small></div></li>
          <li><span>✓</span><div><strong>Chaque installation est expliquée</strong><small>Une autorisation système n’est demandée qu’au moment nécessaire.</small></div></li>
          <li><span>✓</span><div><strong>La sécurité est revérifiée</strong><small>La progression visuelle est mémorisée, mais jamais les validations sensibles.</small></div></li>
        </ul>
        <button id="start-onboarding" class="primary large welcome-action">Commencer la configuration</button>
        <p class="notice">Vous pourrez fermer l’application et reprendre plus tard.</p>
      </section>
    </main>`;

  document.querySelector<HTMLButtonElement>('#start-onboarding')?.addEventListener('click', () => {
    completeIntroduction();
    void refresh();
  });
}

async function refresh(): Promise<void> {
  app.innerHTML = '<main class="loading" aria-live="polite"><div class="spinner"></div><p>Vérification sécurisée de votre ordinateur…</p></main>';

  try {
    const status = await invoke<HostStatus>('host_status');
    const safeProgress = Math.round(Math.min(100, Math.max(0, status.progress)));
    const emergencyStopped = status.lifecycle === 'emergency_stopped';
    const online = status.lifecycle === 'online';
    const automation = resourceAutomationView(status.lifecycle);

    app.innerHTML = `
      <main class="layout">
        <aside class="sidebar" aria-label="Progression de la configuration">
          <div class="brand"><span class="brand-mark">G</span><div><strong>GPUbnb Host</strong><small>Simple, privé, sécurisé</small></div></div>
          <ol class="steps">
            <li class="done"><span>1</span><div><strong>Application installée</strong><small>GPUbnb Host fonctionne</small></div></li>
            <li class="${status.ready ? 'done' : 'active'}"><span>2</span><div><strong>Protéger cet ordinateur</strong><small>${status.ready ? 'Protections validées' : 'Vérifications guidées'}</small></div></li>
            <li class="${status.ready && !online ? 'active' : online ? 'done' : ''}"><span>3</span><div><strong>Disponibilités</strong><small>Horaires et prix</small></div></li>
            <li class="${online ? 'active' : ''}"><span>4</span><div><strong>GPU en ligne</strong><small>Contrôle à tout moment</small></div></li>
          </ol>
          <div class="help-card"><strong>Vous gardez le contrôle</strong><p>GPUbnb ne partage jamais votre session personnelle. Une protection manquante bloque automatiquement la location.</p></div>
        </aside>

        <section class="content">
          <header class="topbar">
            <div><p class="eyebrow">GPUbnb Host</p><h1>${online ? 'Votre GPU est disponible.' : 'Installez tout, une étape à la fois.'}</h1><p class="lead">Pas de commande technique : l’application explique, vérifie et bloque toute opération risquée.</p></div>
            <div class="status-stack"><span class="status-pill ${status.lifecycle}"><span></span>${lifecycleLabel(status.lifecycle)}</span><span class="badge">${escapeHtml(status.platform)} · ${escapeHtml(status.architecture)}</span></div>
          </header>

          ${emergencyStopped ? '<section class="alert-card danger" role="alert"><div class="shield" aria-hidden="true">!</div><div><strong>Arrêt d’urgence actif</strong><p>Aucune nouvelle location ne peut démarrer avant une révision complète.</p></div></section>' : ''}

          <section class="alert-card safe">
            <div class="shield" aria-hidden="true">✓</div>
            <div><strong>Votre bureau et vos fichiers restent privés</strong><p>Le locataire utilisera uniquement un environnement temporaire séparé, sans accès à vos documents ni à vos comptes.</p></div>
          </section>

          <section class="progress-card" aria-labelledby="progress-title">
            <div class="progress-heading"><div><p class="eyebrow">État de préparation</p><h2 id="progress-title">${escapeHtml(status.summary)}</h2><p>${status.blockingCount === 0 ? 'Tous les contrôles obligatoires sont validés.' : `${status.blockingCount} contrôle${status.blockingCount > 1 ? 's' : ''} bloque${status.blockingCount > 1 ? 'nt' : ''} encore l’activation.`}</p></div><strong>${safeProgress}%</strong></div>
            <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${safeProgress}"><span style="width:${safeProgress}%"></span></div>
          </section>

          ${status.nextActionId === 'account' ? renderPairingGuide(status.pairing) : ''}

          <p id="action-status" class="action-status" aria-live="polite"></p>
          <ul class="checks">${status.checks.map((check) => renderCheck(check, status.nextActionId)).join('')}</ul>

          ${renderResourceAutomation(automation)}

          <section class="explanation">
            <div><p class="eyebrow">Installation automatique</p><h2>GPUbnb s’occupe du travail technique</h2></div>
            <div class="benefits">
              <article><span>01</span><strong>Service système</strong><p>L’application expliquera la demande administrateur avant de l’afficher.</p></article>
              <article><span>02</span><strong>Protection automatique</strong><p>Aucun dossier personnel n’est ajouté à l’environnement locataire.</p></article>
              <article><span>03</span><strong>Vérification finale</strong><p>Le bouton de mise en ligne reste bloqué tant qu’un contrôle manque.</p></article>
            </div>
          </section>

          <div class="actions">
            <button id="refresh" class="secondary large">Revérifier</button>
            <button id="publish" class="primary large" ${status.ready && !emergencyStopped && !online ? '' : 'disabled'}>${online ? 'GPU déjà en ligne' : status.ready ? 'Continuer vers mes disponibilités' : 'Terminez la prochaine étape'}</button>
          </div>
          <p class="notice">Aucune location ne démarre sans votre action explicite.</p>
        </section>
      </main>`;

    document.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => void refresh());
    document.querySelector<HTMLButtonElement>('#publish')?.addEventListener('click', () => {
      void invoke('request_publish')
        .then(() => {
          setActionStatus('Activation validée. Le statut est actualisé.', 'success');
          window.setTimeout(() => void refresh(), 500);
        })
        .catch(() => setActionStatus('Activation refusée : une protection obligatoire manque encore.', 'error'));
    });

    document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const actionId = button.dataset.action;
        if (!actionId) return;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        const originalLabel = button.textContent ?? 'Continuer';
        button.textContent = 'Préparation…';

        void invoke<string>('run_setup_action', { actionId })
          .then((result) => {
            if (result === 'open_secure_pairing' && !openPairingPage(status.pairing)) {
              throw new Error('pairing_browser_blocked');
            }
            setActionStatus(friendlyActionMessage(result), 'success');
          })
          .catch((error: unknown) => {
            const errorText = String(error);
            const message = errorText.includes('pairing_service_not_configured')
              ? 'Connexion indisponible : l’adresse du site officiel manque dans cette version.'
              : errorText.includes('pairing_browser_blocked')
                ? `Le navigateur n’a pas pu s’ouvrir automatiquement. Ouvrez cette adresse : ${status.pairing.browserUrl ?? ''}`
                : 'Cette action a été bloquée pour protéger votre ordinateur.';
            setActionStatus(message, 'error');
          })
          .finally(() => {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            button.textContent = originalLabel;
          });
      });
    });
  } catch (error: unknown) {
    app.innerHTML = `
      <main class="error-state">
        <div class="error-icon" aria-hidden="true">!</div>
        <p class="eyebrow">Diagnostic interrompu</p>
        <h1>Votre ordinateur reste protégé.</h1>
        <p>Aucune location n’a été activée. Relancez simplement la vérification.</p>
        <button id="retry" class="primary large">Relancer la vérification</button>
        <details><summary>Détail technique</summary><pre>${escapeHtml(String(error))}</pre></details>
      </main>`;
    document.querySelector<HTMLButtonElement>('#retry')?.addEventListener('click', () => void refresh());
  }
}

if (readOnboardingState().introductionCompleted) {
  void refresh();
} else {
  renderWelcome();
}
