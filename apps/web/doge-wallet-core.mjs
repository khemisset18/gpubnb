/**
 * DOGE/Trust Wallet public-address preview only.
 * No wallet provider, private key, seed, RPC, signing or broadcast is accessed.
 * In particular, a Bitcoin/EVM provider is never a DOGE capability.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAX_ADDRESS_LENGTH = 50;
const MAINNET_ADDRESS_VERSIONS = Object.freeze({30: 'P2PKH', 22: 'P2SH'});

export const TRUST_WALLET_DOGE_STATUS = Object.freeze({
  mode: 'PUBLIC_ADDRESS_PREVIEW_ONLY',
  ownershipVerified: false,
  walletConnected: false,
  dogeRegtestSigningQualified: false,
  htlcSigningEnabled: false,
  exchangeEnabled: false,
  transactionBroadcastEnabled: false,
});

function decodeBase58CheckText(value) {
  if (typeof value !== 'string' || value.length < 26 || value.length > MAX_ADDRESS_LENGTH ||
      ![...value].every(char => ALPHABET.includes(char))) {
    throw new Error('Adresse DOGE invalide : format Base58 incorrect.');
  }
  let numeric = 0n;
  for (const char of value) numeric = numeric * 58n + BigInt(ALPHABET.indexOf(char));
  const digits = [];
  while (numeric > 0n) {
    digits.push(Number(numeric & 255n));
    numeric >>= 8n;
  }
  digits.reverse();
  const prefixZeros = value.match(/^1*/)[0].length;
  const decoded = Uint8Array.from([...Array(prefixZeros).fill(0), ...digits]);
  if (decoded.length !== 25) throw new Error('Adresse DOGE invalide : longueur inattendue.');
  return decoded;
}

async function doubleSha256(bytes, cryptoProvider) {
  if (!cryptoProvider?.subtle?.digest) throw new Error('HTTPS requis pour contrôler l’adresse DOGE.');
  const first = await cryptoProvider.subtle.digest('SHA-256', bytes);
  return new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', first));
}

/** Verify checksum AND Dogecoin mainnet version, offline; never verify ownership. */
export async function inspectPublicDogeAddress(candidate, cryptoProvider = globalThis.crypto) {
  // Personal Trust Wallet addresses are mainnet addresses; this is merely an
  // offline, public-only format preview. The GPUbnb DOGE Regtest is separate.
  if (typeof candidate !== 'string') throw new Error('Saisis uniquement une adresse DOGE publique.');
  const address = candidate.trim();
  const bytes = decodeBase58CheckText(address);
  const expected = await doubleSha256(bytes.subarray(0, 21), cryptoProvider);
  let mismatch = 0;
  for (let i = 0; i < 4; i++) mismatch |= bytes[21 + i] ^ expected[i];
  if (mismatch !== 0) throw new Error('Adresse DOGE invalide : checksum incorrect.');
  const scriptType = MAINNET_ADDRESS_VERSIONS[bytes[0]];
  if (!scriptType) throw new Error('Réseau non pris en charge : adresse DOGE Mainnet publique uniquement.');
  return Object.freeze({
    address,
    asset: 'DOGE',
    network: 'dogecoin-mainnet',
    scriptType,
    verification: 'FORMAT_CHECK_ONLY',
    ownershipVerified: false,
    walletConnected: false,
    canSign: false,
    canTrade: false,
    canBroadcast: false,
  });
}

/** Deliberately cannot infer DOGE signing from installed EVM, BTC or Solana wallets. */
export function getTrustWalletDogeStatus() {
  return TRUST_WALLET_DOGE_STATUS;
}
