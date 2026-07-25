const cards = [...document.querySelectorAll('[data-download-platform]')];

for (const card of cards) {
  const button = card.querySelector('[data-download-button]');
  const status = card.querySelector('[data-download-status]');

  if (!button || !status) continue;

  status.textContent = 'Téléchargement direct depuis GitHub Releases.';
  button.rel = 'noopener';
}
