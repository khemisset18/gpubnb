import { invoke } from '@tauri-apps/api/core';
import {
  buildPrivacySafeSupportReport,
  type SupportStatusInput,
} from './support-report';

const PANEL_ID = 'gpubnb-owner-support-panel';

const escapeHtml = (value: string): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
})[char] ?? char);

const lifecycleLabel = (value: string): string => ({
  setup_required: 'Action requise',
  ready: 'Prêt',
  online: 'En ligne',
  emergency_stopped: 'Arrêté',
})[value] ?? 'État inconnu';

const standbyCopy = (status: SupportStatusInput): string => {
  if (!status.ready) {
    return 'GPUbnb Standby sera disponible après correction des contrôles bloquants.';
  }
  if (status.lifecycle === 'online') {
    return 'Host en ligne : l’écran peut s’éteindre normalement. GPUbnb maintient le système joignable selon la politique serveur.';
  }
  return 'Host prêt. Mettez le GPU en ligne pour permettre GPUbnb Standby lorsque vous quittez le PC.';
};

const ensureStyle = (): void => {
  if (document.querySelector('[data-gpubnb-owner-support-style]')) return;
  const style = document.createElement('style');
  style.dataset.gpubnbOwnerSupportStyle = 'true';
  style.textContent = `
    #${PANEL_ID}{position:fixed;right:18px;bottom:18px;z-index:30;width:min(360px,calc(100vw - 36px));padding:14px;border:1px solid rgba(127,127,127,.28);border-radius:14px;background:color-mix(in srgb,Canvas 94%,transparent);color:CanvasText;box-shadow:0 12px 36px rgba(0,0,0,.24);backdrop-filter:blur(12px);font:13px/1.4 system-ui,sans-serif}
    #${PANEL_ID} .gpubnb-support-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
    #${PANEL_ID} h2{font-size:15px;margin:0 0 2px}
    #${PANEL_ID} p{margin:6px 0;color:color-mix(in srgb,CanvasText 72%,transparent)}
    #${PANEL_ID} .gpubnb-support-badge{font-weight:700;white-space:nowrap}
    #${PANEL_ID} .gpubnb-support-actions{display:flex;gap:8px;margin-top:10px}
    #${PANEL_ID} button{appearance:none;border:1px solid rgba(127,127,127,.38);border-radius:9px;background:Canvas;color:CanvasText;padding:7px 10px;cursor:pointer;font:inherit}
    #${PANEL_ID} button:hover{filter:brightness(1.08)}
    #${PANEL_ID} [data-copy-result]{min-height:18px;margin-top:6px;font-size:12px}
  `;
  document.head.append(style);
};

const copyText = async (value: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('clipboard_unavailable');
};

const render = (status: SupportStatusInput): HTMLElement => {
  const existing = document.getElementById(PANEL_ID);
  const panel = existing ?? document.createElement('aside');
  panel.id = PANEL_ID;
  panel.setAttribute('aria-label', 'État et support GPUbnb Host');
  const failedChecks = status.checks.filter((check) => check.blocking && !check.ok).length;
  const badge = status.ready ? lifecycleLabel(status.lifecycle) : `${failedChecks} action${failedChecks === 1 ? '' : 's'} requise${failedChecks === 1 ? '' : 's'}`;
  panel.innerHTML = `
    <div class="gpubnb-support-head">
      <div><h2>État GPUbnb Host</h2><p>${escapeHtml(status.summary)}</p></div>
      <span class="gpubnb-support-badge">${escapeHtml(badge)}</span>
    </div>
    <p><strong>GPUbnb Standby :</strong> ${escapeHtml(standbyCopy(status))}</p>
    <p>Agent ${status.agent.running ? 'actif' : 'à vérifier'} · GPU ${status.diagnostic.canHost ? 'compatible' : 'à vérifier'} · ${status.platform} ${status.architecture}</p>
    <div class="gpubnb-support-actions">
      <button type="button" data-copy-diagnostic>Copier le diagnostic</button>
      <button type="button" data-refresh-support>Actualiser</button>
    </div>
    <p data-copy-result role="status"></p>
  `;

  panel.querySelector<HTMLButtonElement>('[data-copy-diagnostic]')?.addEventListener('click', async () => {
    const result = panel.querySelector<HTMLElement>('[data-copy-result]');
    try {
      const report = buildPrivacySafeSupportReport(status);
      await copyText(JSON.stringify(report, null, 2));
      if (result) result.textContent = 'Diagnostic copié — aucun token, mot de passe ou clé privée n’est inclus.';
    } catch {
      if (result) result.textContent = 'Impossible de copier le diagnostic automatiquement.';
    }
  });

  panel.querySelector<HTMLButtonElement>('[data-refresh-support]')?.addEventListener('click', () => {
    void refreshOwnerSupportPanel();
  });
  return panel;
};

export const refreshOwnerSupportPanel = async (): Promise<void> => {
  ensureStyle();
  try {
    const status = await invoke<SupportStatusInput>('host_status');
    const panel = render(status);
    if (!panel.isConnected) document.body.append(panel);
  } catch {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      const result = existing.querySelector<HTMLElement>('[data-copy-result]');
      if (result) result.textContent = 'État local momentanément indisponible.';
    }
  }
};

window.addEventListener('DOMContentLoaded', () => {
  void refreshOwnerSupportPanel();
});
