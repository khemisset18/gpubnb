import { invoke } from '@tauri-apps/api/core';
import './styles.css';

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
  progress: number;
  summary: string;
  checks: Check[];
};

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('missing_app_root');

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
})[char] ?? char);

const renderCheck = (check: Check): string => `
  <li class="check ${check.ok ? 'ok' : 'blocked'}">
    <span class="check-icon" aria-hidden="true">${check.ok ? '✓' : '!'}</span>
    <div class="check-copy">
      <strong>${escapeHtml(check.label)}</strong>
      <small>${escapeHtml(check.detail)}</small>
    </div>
    ${!check.ok && check.actionLabel ? `<button class="secondary" data-action="${escapeHtml(check.id)}">${escapeHtml(check.actionLabel)}</button>` : ''}
  </li>`;

async function refresh(): Promise<void> {
  app.innerHTML = '<main class="loading" aria-live="polite"><div class="spinner"></div><p>Vérification sécurisée de votre ordinateur…</p></main>';

  try {
    const status = await invoke<HostStatus>('host_status');
    const safeProgress = Math.min(100, Math.max(0, status.progress));

    app.innerHTML = `
      <main class="layout">
        <aside class="sidebar" aria-label="Progression de la configuration">
          <div class="brand"><span class="brand-mark">G</span><div><strong>GPUbnb Host</strong><small>Configuration sécurisée</small></div></div>
          <ol class="steps">
            <li class="done"><span>1</span><div><strong>Application installée</strong><small>GPUbnb Host fonctionne</small></div></li>
            <li class="active"><span>2</span><div><strong>Protéger cet ordinateur</strong><small>Vérifications automatiques</small></div></li>
            <li><span>3</span><div><strong>Choisir vos disponibilités</strong><small>Prix et horaires simples</small></div></li>
            <li><span>4</span><div><strong>Mettre le GPU en ligne</strong><small>Activation en un clic</small></div></li>
          </ol>
          <div class="help-card"><strong>Besoin d’aide ?</strong><p>Chaque étape indique exactement quoi faire. Aucun réglage technique n’est nécessaire sans explication.</p></div>
        </aside>

        <section class="content">
          <header class="topbar">
            <div><p class="eyebrow">Étape 2 sur 4</p><h1>Votre ordinateur reste privé.</h1></div>
            <span class="badge">${escapeHtml(status.platform)} · ${escapeHtml(status.architecture)}</span>
          </header>

          <section class="privacy-card">
            <div class="shield" aria-hidden="true">✓</div>
            <div><strong>Vos fichiers personnels ne sont jamais partagés</strong><p>Le locataire utilisera uniquement un espace temporaire isolé. Il ne verra ni votre bureau, ni vos documents, ni vos comptes.</p></div>
          </section>

          <section class="progress-card" aria-labelledby="progress-title">
            <div class="progress-heading"><div><p class="eyebrow">Vérification automatique</p><h2 id="progress-title">${escapeHtml(status.summary)}</h2></div><strong>${safeProgress}%</strong></div>
            <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${safeProgress}"><span style="width:${safeProgress}%"></span></div>
          </section>

          <ul class="checks">${status.checks.map(renderCheck).join('')}</ul>

          <section class="explanation">
            <h2>Ce que GPUbnb fera automatiquement</h2>
            <div class="benefits">
              <article><strong>Session séparée</strong><p>Création d’un environnement temporaire réservé au locataire.</p></article>
              <article><strong>Accès limité</strong><p>Aucun disque personnel ni dossier privé n’est partagé.</p></article>
              <article><strong>Nettoyage complet</strong><p>La session, les clés et les fichiers temporaires sont supprimés à la fin.</p></article>
            </div>
          </section>

          <div class="actions">
            <button id="refresh" class="secondary large">Revérifier mon ordinateur</button>
            <button id="publish" class="primary large" ${status.ready ? '' : 'disabled'}>${status.ready ? 'Continuer vers mes disponibilités' : 'Protection incomplète'}</button>
          </div>
          <p class="notice">GPUbnb bloque automatiquement toute location tant qu’une protection obligatoire manque.</p>
        </section>
      </main>`;

    document.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => void refresh());
    document.querySelector<HTMLButtonElement>('#publish')?.addEventListener('click', () => {
      void invoke('request_publish').catch((error) => console.error('publish_request_failed', error));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.action ?? 'unknown';
        console.info('guided_action_requested', action);
      });
    });
  } catch (error) {
    app.innerHTML = `
      <main class="error-state">
        <div class="error-icon" aria-hidden="true">!</div>
        <h1>Nous n’avons pas pu vérifier cet ordinateur</h1>
        <p>Aucune location n’a été activée. Vous pouvez relancer le diagnostic en toute sécurité.</p>
        <button id="retry" class="primary large">Réessayer</button>
        <details><summary>Afficher le détail technique</summary><pre>${escapeHtml(String(error))}</pre></details>
      </main>`;
    document.querySelector<HTMLButtonElement>('#retry')?.addEventListener('click', () => void refresh());
  }
}

void refresh();
