import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  IdentityConflictError,
  type IdentityRecord,
  type IdentityStore,
  type WalletRecord,
  isSessionVersionCurrent,
  linkIdentity,
  linkWallet,
  normalizePseudonym,
  pseudonymLookupKey,
  safeSecurityMetadata,
} from '../src/identity.js';

class MemoryIdentityStore implements IdentityStore {
  identities: IdentityRecord[] = [];
  wallets: WalletRecord[] = [];

  async transaction<T>(callback: (store: IdentityStore) => Promise<T>): Promise<T> {
    return callback(this);
  }
  async findIdentity(provider: string, subject: string) {
    return this.identities.find((identity) => identity.provider === provider && identity.subject === subject) ?? null;
  }
  async insertIdentity(input: { userId: string; provider: string; subject: string }) {
    const identity = { id: `identity-${this.identities.length}`, ...input };
    this.identities.push(identity);
    return identity;
  }
  async findWallet(address: string) {
    return this.wallets.find((wallet) => wallet.address === address) ?? null;
  }
  async insertWallet(input: { userId: string; address: string }) {
    const wallet = { id: `wallet-${this.wallets.length}`, userId: input.userId, address: input.address };
    this.wallets.push(wallet);
    return wallet;
  }
}

test('pseudonyms have a stable case-insensitive key and reject reserved or confusable names', () => {
  assert.equal(normalizePseudonym('  Alice_42 '), 'Alice_42');
  assert.equal(pseudonymLookupKey('Alice_42'), 'alice_42');
  assert.throws(() => normalizePseudonym('support'), (error: unknown) => error instanceof IdentityConflictError);
  assert.throws(() => normalizePseudonym('аdmin'), (error: unknown) => error instanceof IdentityConflictError);
});

test('an external identity is idempotent for its owner and cannot belong to another account', async () => {
  const store = new MemoryIdentityStore();
  const first = await linkIdentity(store, { userId: 'user-a', provider: 'Google', subject: 'google-123' });
  assert.equal(await linkIdentity(store, { userId: 'user-a', provider: 'google', subject: 'google-123' }), first);
  await assert.rejects(
    linkIdentity(store, { userId: 'user-b', provider: 'google', subject: 'google-123' }),
    (error: unknown) => error instanceof IdentityConflictError && error.code === 'identity_already_linked',
  );
});

test('a canonical Solana wallet cannot belong to two accounts', async () => {
  const store = new MemoryIdentityStore();
  const address = Keypair.generate().publicKey.toBase58();
  await linkWallet(store, { userId: 'user-a', address, authenticate: true });
  await assert.rejects(
    linkWallet(store, { userId: 'user-b', address }),
    (error: unknown) => error instanceof IdentityConflictError && error.code === 'wallet_already_linked',
  );
  assert.equal(store.wallets.length, 1);
});

test('security metadata redacts credentials and bounds untrusted values', () => {
  const metadata = safeSecurityMetadata({ reason: 'x'.repeat(500), accessToken: 'secret', nested: { unsafe: true } });
  assert.equal(metadata.reason, 'x'.repeat(200));
  assert.equal('accessToken' in metadata, false);
  assert.equal('nested' in metadata, false);
});

test('incrementing a user session version invalidates prior sessions', () => {
  assert.equal(isSessionVersionCurrent(3, 3), true);
  assert.equal(isSessionVersionCurrent(3, 4), false);
  assert.equal(isSessionVersionCurrent(0, 0), false);
});
