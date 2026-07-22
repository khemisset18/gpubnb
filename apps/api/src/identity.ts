import { PublicKey } from '@solana/web3.js';

const PSEUDONYM_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,31}$/;
const RESERVED_PSEUDONYMS = new Set([
  'admin',
  'administrator',
  'api',
  'billing',
  'gpubnb',
  'help',
  'moderator',
  'official',
  'root',
  'security',
  'staff',
  'support',
  'system',
]);

export class IdentityConflictError extends Error {
  constructor(readonly code: 'identity_already_linked' | 'wallet_already_linked' | 'pseudonym_unavailable') {
    super(code);
    this.name = 'IdentityConflictError';
  }
}

/**
 * Usernames intentionally use a conservative ASCII alphabet. Besides producing
 * stable URLs, this prevents common Unicode homoglyph and normalization attacks.
 */
export function normalizePseudonym(input: string): string {
  const pseudonym = input.normalize('NFKC').trim();
  if (!PSEUDONYM_PATTERN.test(pseudonym) || RESERVED_PSEUDONYMS.has(pseudonym.toLowerCase())) {
    throw new IdentityConflictError('pseudonym_unavailable');
  }
  return pseudonym;
}

export function pseudonymLookupKey(input: string): string {
  return normalizePseudonym(input).toLowerCase();
}

export function canonicalWalletAddress(input: string): string {
  return new PublicKey(input).toBase58();
}

export type IdentityRecord = {
  id: string;
  userId: string;
  provider: string;
  subject: string;
};

export type WalletRecord = {
  id: string;
  userId: string;
  address: string;
};

/** Implementations must execute each callback in a serializable DB transaction. */
export interface IdentityStore {
  transaction<T>(callback: (store: IdentityStore) => Promise<T>): Promise<T>;
  findIdentity(provider: string, subject: string): Promise<IdentityRecord | null>;
  insertIdentity(input: { userId: string; provider: string; subject: string; email?: string; emailVerified: boolean }): Promise<IdentityRecord>;
  findWallet(address: string): Promise<WalletRecord | null>;
  insertWallet(input: {
    userId: string;
    address: string;
    canAuthenticate: boolean;
    canPay: boolean;
    canReceive: boolean;
  }): Promise<WalletRecord>;
}

export async function linkIdentity(
  store: IdentityStore,
  input: { userId: string; provider: string; subject: string; email?: string; emailVerified?: boolean },
): Promise<IdentityRecord> {
  const provider = input.provider.trim().toLowerCase();
  const subject = input.subject.trim();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(provider) || subject.length === 0 || subject.length > 255) {
    throw new TypeError('invalid_identity');
  }
  return store.transaction(async (tx) => {
    const existing = await tx.findIdentity(provider, subject);
    if (existing) {
      if (existing.userId !== input.userId) throw new IdentityConflictError('identity_already_linked');
      return existing;
    }
    return tx.insertIdentity({
      userId: input.userId,
      provider,
      subject,
      ...(input.email ? { email: input.email.trim().toLowerCase() } : {}),
      emailVerified: input.emailVerified ?? false,
    });
  });
}

export async function linkWallet(
  store: IdentityStore,
  input: { userId: string; address: string; authenticate?: boolean; pay?: boolean; receive?: boolean },
): Promise<WalletRecord> {
  const address = canonicalWalletAddress(input.address);
  return store.transaction(async (tx) => {
    const existing = await tx.findWallet(address);
    if (existing) {
      if (existing.userId !== input.userId) throw new IdentityConflictError('wallet_already_linked');
      return existing;
    }
    return tx.insertWallet({
      userId: input.userId,
      address,
      canAuthenticate: input.authenticate ?? false,
      canPay: input.pay ?? true,
      canReceive: input.receive ?? false,
    });
  });
}

const FORBIDDEN_METADATA_KEYS = /authorization|cookie|credential|password|secret|signature|token/i;

/** Security events accept only shallow scalar metadata and silently drop secrets. */
export function safeSecurityMetadata(input: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_METADATA_KEYS.test(key) || Object.keys(output).length >= 20) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') output[key] = value;
    else if (typeof value === 'string') output[key] = value.slice(0, 200);
  }
  return output;
}

export function isSessionVersionCurrent(sessionVersion: number, currentUserVersion: number): boolean {
  return Number.isSafeInteger(sessionVersion) && sessionVersion > 0 && sessionVersion === currentUserVersion;
}
