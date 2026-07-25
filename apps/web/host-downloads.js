const cards = [...document.querySelectorAll('[data-download-platform]')];

for (const card of cards) {
  const platform = card.dataset.downloadPlatform;
  const button = card.querySelector('[data-download-button]');
  const status = card.querySelector('[data-download-status]');

  if (!platform || !button || !status) continue;

  button.setAttribute('aria-disabled', 'true');
  button.classList.add('is-disabled');

  fetch(`/.netlify/functions/host-download?platform=${encodeURIComponent(platform)}&check=1`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('status_unavailable')))
    .then((result) => {
      if (!result.available) {
        status.textContent = 'Installateur pas encore publié.';
        return;
      }

      status.textContent = 'Installateur disponible.';
      button.href = `/.netlify/functions/host-download?platform=${encodeURIComponent(platform)}`;
      button.removeAttribute('aria-disabled');
      button.classList.remove('is-disabled');
      button.textContent = `Télécharger pour ${result.label}`;
    })
    .catch(() => {
      status.textContent = 'Disponibilité impossible à vérifier pour le moment.';
    });
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-download-button][aria-disabled="true"]');
  if (button) event.preventDefault();
});
