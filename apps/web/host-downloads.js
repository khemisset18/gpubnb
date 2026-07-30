(function (root) {
  'use strict';

  const labels = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };
  const endpoint = '/.netlify/functions/host-download';

  function detectPlatform(navigatorLike = {}) {
    const value = `${navigatorLike.userAgentData?.platform || ''} ${navigatorLike.platform || ''} ${navigatorLike.userAgent || ''}`.toLowerCase();
    if (value.includes('win')) return 'windows';
    if (value.includes('mac')) return 'macos';
    if (value.includes('linux')) return 'linux';
    return null;
  }

  function detectArchitecture(navigatorLike = {}) {
    const value = `${navigatorLike.userAgentData?.architecture || ''} ${navigatorLike.userAgent || ''}`.toLowerCase();
    if (/(arm64|aarch64|apple silicon)/.test(value)) return 'arm64';
    if (/(x86_64|x64|win64|amd64)/.test(value)) return 'x64';
    return null;
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return 'Inconnue';
    return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(value / 1024 / 1024)} Mo`;
  }

  async function fetchMetadata(platform, fetchImpl = fetch, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}?platform=${encodeURIComponent(platform)}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || typeof data.available !== 'boolean') throw new Error(data.error || 'invalid_response');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function renderCard(card, metadata) {
    const platform = card.dataset.downloadPlatform;
    const button = card.querySelector('[data-download-button]');
    const status = card.querySelector('[data-download-availability]');
    if (!button || !status) return;
    if (!metadata.available) {
      button.removeAttribute('href');
      button.setAttribute('aria-disabled', 'true');
      button.textContent = `Version ${labels[platform]} indisponible`;
      status.textContent = 'Indisponible : le fichier n’est pas publié dans la release.';
      return;
    }
    button.href = metadata.downloadUrl;
    button.removeAttribute('aria-disabled');
    button.textContent = `Télécharger pour ${labels[platform]}`;
    button.addEventListener('click', () => {
      button.textContent = 'Préparation du téléchargement…';
    }, { once: true });
    status.textContent = 'Disponible';
    for (const [field, value] of Object.entries({
      version: metadata.version,
      published: metadata.publishedAt ? new Date(metadata.publishedAt).toLocaleDateString('fr-FR') : 'Inconnue',
      size: formatBytes(metadata.size),
      checksum: metadata.sha256 || 'Non publiée',
    })) {
      const node = card.querySelector(`[data-download-${field}]`);
      if (node) node.textContent = value;
    }
  }

  async function initialize(doc = document, navigatorLike = navigator) {
    const recommended = detectPlatform(navigatorLike);
    const architecture = detectArchitecture(navigatorLike);
    const cards = [...doc.querySelectorAll('[data-download-platform]')];
    await Promise.all(cards.map(async card => {
      const platform = card.dataset.downloadPlatform;
      const button = card.querySelector('[data-download-button]');
      const status = card.querySelector('[data-download-availability]');
      if (!button || !status) return;
      button.removeAttribute('href');
      button.setAttribute('aria-disabled', 'true');
      button.textContent = 'Vérification…';
      status.textContent = 'Vérification du fichier…';
      if (platform === recommended && (platform !== 'macos' || !architecture || architecture === 'arm64')) {
        card.classList.add('recommended');
        card.querySelector('[data-recommended]').hidden = false;
      }
      try {
        renderCard(card, await fetchMetadata(platform));
      } catch {
        button.textContent = `Version ${labels[platform]} non vérifiée`;
        status.textContent = 'Impossible de vérifier actuellement la disponibilité. Consultez la release GitHub.';
      }
    }));
  }

  const api = { detectArchitecture, detectPlatform, fetchMetadata, formatBytes, renderCard };
  if (typeof module !== 'undefined') module.exports = api;
  root.GPUBNB_HOST_DOWNLOADS = api;
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => initialize());
})(typeof window !== 'undefined' ? window : globalThis);
