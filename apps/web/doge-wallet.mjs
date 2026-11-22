import { inspectPublicDogeAddress, getTrustWalletDogeStatus } from './doge-wallet-core.mjs';

const form = document.querySelector('#doge-public-address-form');
const field = document.querySelector('#doge-public-address');
const output = document.querySelector('#doge-address-result');
const clear = document.querySelector('#doge-clear');
const status = getTrustWalletDogeStatus();

if (!form || !field || !output || !clear || status.exchangeEnabled || status.htlcSigningEnabled) {
  throw new Error('La page de prévisualisation DOGE doit rester en lecture seule.');
}

function showMessage(message, isError = false) {
  output.replaceChildren();
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  if (isError) paragraph.className = 'tw-error';
  output.append(paragraph);
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  output.replaceChildren();
  try {
    const details = await inspectPublicDogeAddress(field.value);
    // Keep the public address in memory/display only; no storage or API request.
    const address = document.createElement('code');
    address.textContent = details.address;
    const description = document.createElement('p');
    description.textContent = 'Adresse ' + details.asset + ' ' + details.scriptType +
      ' : format et checksum valides. Cette adresse n’est PAS connectée ni prouvée comme t’appartenant. Aucun échange n’est activé.';
    output.append(address, description);
    clear.hidden = false;
  } catch (error) {
    showMessage(error instanceof Error ? error.message : 'Adresse DOGE invalide.', true);
    clear.hidden = true;
  }
});

clear.addEventListener('click', () => {
  field.value = '';
  clear.hidden = true;
  showMessage('Aucune adresse affichée. Aucune donnée enregistrée.');
  field.focus();
});
