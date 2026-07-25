const cards = [...document.querySelectorAll('[data-download-platform]')];

for (const card of cards) {
  const platform = card.dataset.downloadPlatform;
  const button = card.querySelector('[data-download-button]');
  const status = card.querySelector('[data-download-status]');

  if (!platform || !button || !status) continue;

  fetch(`/.netlify/functions/host-download?platform=${encodeURIComponent(platform)}&check=1`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('status_unavailable')))
    .then((result) => {
      status.textContent = result.available
        ? 'Installateur disponible.'
        : 'La publication n’a pas pu être confirmée. Le téléchargement reste accessible.';
      button.href = `/.netlify/functions/host-download?platform=${encodeURIComponent(platform)}`;
      button.textContent = `Télécharger pour ${result.label}`;
    })
    .catch(() => {
      status.textContent = 'Vérification indisponible. Vous pouvez tout de même essayer le téléchargement.';
    });
}
