'use strict';

const API = (globalThis.GPUBNB_API_URL || '').replace(/\/$/, '');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let csrfToken = null;
let currentUserId = null;

export function encode58(bytes) {
  if (!bytes.length) return '';
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = '';
  for (let index = 0; index < bytes.length && bytes[index] === 0; index += 1) output += '1';
  if (digits.length === 1 && digits[0] === 0) return output;
  for (let index = digits.length - 1; index >= 0; index -= 1) output += ALPHABET[digits[index]];
  return output;
}

export function formatSol(lamports) {
  if (typeof lamports !== 'string' || !/^\d+$/.test(lamports)) return null;
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '').slice(0, 6);
  return `${whole.toLocaleString('fr-FR')}${fraction ? `,${fraction}` : ''} SOL`;
}

export function walletProofEndpoint(hasAuthenticatedAccount) {
  return hasAuthenticatedAccount ? '/auth/wallet/link' : '/auth/verify';
}

export async function jsonFetch(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${API}${path}`, {
      credentials: 'include',
      ...options,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(csrfToken && options.method && options.method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : {};
    if (!response.ok) throw new Error(body.error || `Erreur API (${response.status})`);
    return body;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Le serveur met trop de temps à répondre. Réessayez.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function validListing(listing) {
  return listing && typeof listing.id === 'string' && typeof listing.title === 'string'
    && typeof listing.description === 'string' && listing.machine && listing.owner
    && formatSol(listing.hourlyLamports) !== null;
}

async function bootstrap() {
  const listings = document.querySelector('#listings');
  const status = document.querySelector('#apiStatus');
  const networkWarning = document.querySelector('#networkWarning');
  const accountButton = document.querySelector('#accountButton');
  const refreshButton = document.querySelector('#refresh');
  if (!listings || !status || !networkWarning || !refreshButton) return;

  async function authenticate() {
    const provider = globalThis.phantom?.solana || globalThis.solana;
    if (!provider?.isPhantom) throw new Error('Installez Phantom pour continuer.');
    await provider.connect();
    const wallet = provider.publicKey.toString();
    const challenge = await jsonFetch('/auth/nonce', { method: 'POST', body: JSON.stringify({ wallet }) });
    if (typeof challenge.message !== 'string') throw new Error('Challenge Phantom invalide.');
    const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
    const proof = { wallet, message: challenge.message, signature: encode58(signed.signature) };
    if (currentUserId) {
      await jsonFetch(walletProofEndpoint(true), { method: 'POST', body: JSON.stringify(proof) });
    } else {
      const authenticated = await jsonFetch(walletProofEndpoint(false), { method: 'POST', body: JSON.stringify(proof) });
      csrfToken = authenticated.csrfToken;
      currentUserId = authenticated.user?.id || null;
    }
    if (accountButton) accountButton.textContent = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
    return provider;
  }

  async function rentOneHour(listing, button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    const originalLabel = button.textContent;
    try {
      button.textContent = 'Connexion…';
      const provider = await authenticate();
      const startsAt = new Date(Date.now() + 5 * 60_000);
      const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
      button.textContent = 'Réservation…';
      const booking = await jsonFetch('/bookings', { method: 'POST', body: JSON.stringify({ listingId: listing.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), idempotencyKey: crypto.randomUUID() }) });
      const price = formatSol(booking.quotedLamports);
      if (!price) throw new Error('Montant de réservation invalide.');
      if (!confirm(`Bloquer ${price} dans l’escrow pour une location d’une heure ?`)) return;
      button.textContent = 'Signature…';
      const intent = await jsonFetch(`/bookings/${booking.id}/payment-intent`, { method: 'POST', body: '{}' });
      const bytes = Uint8Array.from(atob(intent.transactionBase64), character => character.charCodeAt(0));
      const transaction = globalThis.solanaWeb3.Transaction.from(bytes);
      const sent = await provider.signAndSendTransaction(transaction);
      button.textContent = 'Confirmation…';
      await jsonFetch(`/bookings/${booking.id}/confirm-deposit`, { method: 'POST', body: JSON.stringify({ signature: sent.signature }) });
      status.textContent = `Paiement confirmé · ${sent.signature.slice(0, 8)}…`;
    } catch (error) {
      console.error('booking_failed', error);
      status.textContent = error instanceof Error ? error.message : 'Impossible de terminer la réservation.';
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = originalLabel;
    }
  }

  function renderCard(listing) {
    if (!validListing(listing)) return null;
    const card = element('article', undefined, 'card');
    const metadata = element('div', undefined, 'meta');
    metadata.append(
      element('span', `${listing.machine.gpuModel || 'GPU'} · ${listing.machine.vramMiB || '—'} MiB`),
      element('span', listing.owner.pseudonym || 'Fournisseur'),
    );
    const rent = element('button', 'Louer 1 heure');
    rent.type = 'button';
    rent.addEventListener('click', () => rentOneHour(listing, rent));
    card.append(
      element('span', '● GPU connecté', 'eyebrow'),
      element('h3', listing.title),
      element('p', listing.description),
      metadata,
      element('div', `${formatSol(listing.hourlyLamports)}/h`, 'price'),
      rent,
    );
    return card;
  }

  async function load() {
    refreshButton.disabled = true;
    listings.setAttribute('aria-busy', 'true');
    listings.replaceChildren(element('article', 'Chargement…', 'empty'));
    try {
      const health = await jsonFetch('/health');
      status.textContent = `API active · ${health.cluster || 'réseau inconnu'}`;
      networkWarning.textContent = health.mainnetEnabled ? 'Mainnet activé — paiements réels.' : 'Mode test : Mainnet verrouillé.';
      const response = await jsonFetch('/listings');
      if (!Array.isArray(response)) throw new Error('Réponse marketplace invalide.');
      const cards = response.map(renderCard).filter(Boolean);
      listings.replaceChildren(...(cards.length ? cards : [element('article', 'Aucun GPU vérifié et connecté pour le moment.', 'empty')]));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'API indisponible';
      networkWarning.textContent = 'Connexion API requise.';
      listings.replaceChildren(element('article', 'Impossible de charger les annonces. Vous pouvez réessayer.', 'empty'));
    } finally {
      refreshButton.disabled = false;
      listings.removeAttribute('aria-busy');
    }
  }

  refreshButton.addEventListener('click', load);
  try {
    const me = await jsonFetch('/auth/me');
    csrfToken = me.csrfToken;
    currentUserId = me.user.id;
    if (accountButton) {
      accountButton.textContent = me.user.pseudonym;
      accountButton.href = 'publish.html';
    }
  } catch (error) {
    if (!(error instanceof Error) || !/authentication_required|session_expired/.test(error.message)) console.warn('session_restore_failed');
  }
  await load();
}

if (typeof document !== 'undefined') bootstrap();
