import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectPublicDogeAddress, getTrustWalletDogeStatus } from '../../../apps/web/doge-wallet-core.mjs';

const htmlUrl = new URL('../../../apps/web/doge-wallet.html', import.meta.url);
const scriptUrl = new URL('../../../apps/web/doge-wallet.mjs', import.meta.url);
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function makeAddress(version, filled = 7) {
  const payload = Buffer.concat([Buffer.from([version]), Buffer.alloc(20, filled)]);
  const digest1 = createHash('sha256').update(payload).digest();
  const digest2 = createHash('sha256').update(digest1).digest();
  const data = Buffer.concat([payload, digest2.subarray(0, 4)]);
  let numeric = BigInt('0x' + data.toString('hex'));
  let text = '';
  while (numeric > 0n) { text = alphabet[Number(numeric % 58n)] + text; numeric /= 58n; }
  return '1'.repeat(data.findIndex(n => n !== 0) === -1 ? data.length : data.findIndex(n => n !== 0)) + text;
}

test('Dogecoin P2PKH and P2SH public mainnet addresses pass offline checksum only', async () => {
  for (const [version, type] of [[30, 'P2PKH'], [22, 'P2SH']]) {
    const address = makeAddress(version);
    const result = await inspectPublicDogeAddress(address);
    assert.equal(result.address, address);
    assert.equal(result.network, 'dogecoin-mainnet');
    assert.equal(result.scriptType, type);
    assert.equal(result.verification, 'FORMAT_CHECK_ONLY');
    assert.equal(result.ownershipVerified, false);
    assert.equal(result.walletConnected, false);
    assert.equal(result.canTrade, false);
    assert.equal(result.canSign, false);
    assert.equal(result.canBroadcast, false);
  }
});

test('mangled checksum must be rejected, never silently normalized', async () => {
  const valid = makeAddress(30);
  const changed = valid.slice(0, -1) + (valid.at(-1) === '1' ? '2' : '1');
  await assert.rejects(inspectPublicDogeAddress(changed), /checksum/);
});

test('Bitcoin and Dogecoin testnet/Regtest versions are rejected for personal Trust Wallet preview', async () => {
  for (const version of [0, 5, 111, 113, 196]) {
    await assert.rejects(inspectPublicDogeAddress(makeAddress(version)), /Réseau non pris en charge/);
  }
});

test('reject seeds, non-Base58, extra-long strings, non-string types and missing WebCrypto', async () => {
  for (const value of ['abandon '.repeat(12), '0OIl', 'D'.repeat(51), '', '😀', 123, null, {}]) {
    await assert.rejects(inspectPublicDogeAddress(value));
  }
  await assert.rejects(inspectPublicDogeAddress(makeAddress(30), {}), /HTTPS requis/);
});

test('Trust Wallet DOGE capabilities are explicitly fail closed regardless of extension', () => {
  const s = getTrustWalletDogeStatus();
  assert.deepEqual(s, {
    mode: 'PUBLIC_ADDRESS_PREVIEW_ONLY', ownershipVerified: false,
    walletConnected: false, dogeRegtestSigningQualified: false,
    htlcSigningEnabled: false, exchangeEnabled: false,
    transactionBroadcastEnabled: false,
  });
  assert.equal(Object.isFrozen(s), true);
});

test('UI gives no secret, account-connect, provider, RPC, storage or transaction path', async () => {
  const [html, js] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(scriptUrl, 'utf8')]);
  assert.match(html, /Trust Wallet et Dogecoin/);
  assert.match(html, /aucun paiement|Aucun paiement/i);
  assert.match(html, /disabled aria-disabled="true"/);
  assert.match(html, /type="module" src="doge-wallet\.mjs"/);
  assert.match(html, /doge-wallet\.css/);
  assert.match(js, /inspectPublicDogeAddress/);
  assert.match(js, /textContent = details\.address/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|\bfetch\s*\(|sendTransaction|signTransaction|window\.ethereum|wallet_connect|WalletConnect|signPSBT|\beval\s*\(/i);
});
