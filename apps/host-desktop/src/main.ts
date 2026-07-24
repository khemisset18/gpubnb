import { invoke } from '@tauri-apps/api/core';
import './styles.css';

type Lifecycle = 'setup_required' | 'ready' | 'online' | 'emergency_stopped';

type Check = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  actionLabel?: string | null;
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
    case 'account_link_pending':
      return 'Connexion sécurisée préparée. Aucun mot de passe ne sera stocké dans l’application.';
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

async function refresh(): Promise<void> {
  app.innerHTML = '<main class="loading" aria-live="polite"><div class="spinner"></div><p>Vérification sécurisée de votre ordinateur…</p></main>';

  try {
    const status = await invoke<HostStatus>('host_status');
    const safeProgress = Math.round(Math.min(100, Math.max(0, status.progress)));
    const emergencyStopped = status.lifecycle === 'emergency_stopped';
    const online = status.lifecycle === 'online';

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
            <div><p class="eyebrow">GPUbnb Host</p><h1>${online ? 'Votre GPU est disponible.' : 'Configurez-le sans risque.'}</h1><p class="lead">Une étape à la fois. GPUbnb vérifie tout avant d’autoriser une location.</p></div>
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

          <p id="action-status" class="action-status" aria-live="polite"></p>
          <ul class="checks">${status.checks.map((check) => renderCheck(check, status.nextActionId)).join('')}</ul>

          <section class="explanation">
            <div><p class="eyebrow">Protection automatique</p><h2>GPUbnb s’occupe du travail technique</h2></div>
            <div class="benefits">
              <article><span>01</span><strong>Session séparée</strong><p>Un espace temporaire est créé uniquement pour le locataire.</p></article>
              <article><span>02</span><strong>Accès minimal</strong><p>Aucun dossier personnel n’est monté dans la session.</p></article>
              <article><span>03</span><strong>Nettoyage complet</strong><p>Les accès et fichiers temporaires sont détruits à la fin.</p></article>
            </div>
          </section>

          <div class="actions">
            <button id="refresh" class="secondary large">Revérifier</button>
            <button id="publish" class="primary large" ${status.ready && !emergencyStopped ? '' : 'disabled'}>${online ? 'GPU déjà en ligne' : status.ready ? 'Continuer vers mes disponibilités' : 'Terminez la prochaine étape'}</button>
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
          .then((result) => setActionStatus(friendlyActionMessage(result), 'success'))
          .catch(() => setActionStatus('Cette action a été bloquée pour protéger votre ordinateur.', 'error'))
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

void refresh();
