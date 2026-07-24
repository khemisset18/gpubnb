import { invoke } from '@tauri-apps/api/core';
import './styles.css';

type Check = { id: string; label: string; ok: boolean; detail: string };
type HostStatus = { platform: string; architecture: string; ready: boolean; checks: Check[] };

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('missing_app_root');

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);

async function render(): Promise<void> {
  app.innerHTML = '<section class="shell"><p>Analyse sécurisée de votre ordinateur…</p></section>';
  try {
    const status = await invoke<HostStatus>('host_status');
    const checks = status.checks.map((check) => `
      <li class="check ${check.ok ? 'ok' : 'blocked'}">
        <span aria-hidden="true">${check.ok ? '✓' : '!'}</span>
        <div><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></div>
      </li>`).join('');
    app.innerHTML = `
      <section class="shell">
        <header><div><p class="eyebrow">GPUbnb Host</p><h1>Votre ordinateur reste privé.</h1></div><span class="badge">${escapeHtml(status.platform)} · ${escapeHtml(status.architecture)}</span></header>
        <p class="lead">Les locataires accéderont uniquement à un environnement isolé. Vos documents, votre bureau et vos comptes personnels ne seront jamais partagés.</p>
        <ul>${checks}</ul>
        <button id="publish" ${status.ready ? '' : 'disabled'}>${status.ready ? 'Mettre mon GPU en ligne' : 'Configuration requise'}</button>
        <p class="notice">Le bouton reste bloqué tant que toutes les protections obligatoires ne sont pas actives.</p>
      </section>`;
    document.querySelector<HTMLButtonElement>('#publish')?.addEventListener('click', () => {
      void invoke('request_publish').catch(console.error);
    });
  } catch (error) {
    app.innerHTML = `<section class="shell"><h1>Diagnostic indisponible</h1><p>${escapeHtml(String(error))}</p></section>`;
  }
}

void render();
