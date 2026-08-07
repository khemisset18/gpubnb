import crypto from 'node:crypto';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

const CONFIG_SEED = Buffer.from('config');
const ESCROW_SEED = Buffer.from('escrow');

function discriminator(name: string): Buffer {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function u32le(value: number): Buffer {
  const b = Buffer.alloc(4); b.writeUInt32LE(value); return b;
}
function u64le(value: bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b;
}
function i64le(value: bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigInt64LE(value); return b;
}

export function bookingDigest(bookingId: string): Buffer {
  return crypto.createHash('sha256').update(`gpubnb:${bookingId}`).digest();
}

export function deriveEscrowAddresses(programId: PublicKey, bookingId: string) {
  const booking = bookingDigest(bookingId);
  const [config] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
  const [escrow] = PublicKey.findProgramAddressSync([ESCROW_SEED, booking], programId);
  return { booking, config, escrow };
}

export async function buildOpenEscrowTransaction(input: {
  rpcUrl: string;
  programId: PublicKey;
  buyer: PublicKey;
  provider: PublicKey;
  bookingId: string;
  amount: bigint;
  expectedSeconds: number;
  commitment: 'confirmed' | 'finalized';
  expiresAtUnix: bigint;
}) {
  const { booking, config, escrow } = deriveEscrowAddresses(input.programId, input.bookingId);
  const data = Buffer.concat([
    discriminator('open'), booking, u64le(input.amount), u32le(input.expectedSeconds), i64le(input.expiresAtUnix),
  ]);
  const ix = new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: input.buyer, isSigner: true, isWritable: true },
      { pubkey: input.provider, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const connection = new Connection(input.rpcUrl, input.commitment);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(input.commitment);
  const tx = new Transaction({ feePayer: input.buyer, blockhash, lastValidBlockHeight }).add(ix);
  return { transactionBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'), escrow, config };
}

export async function verifyOpenEscrowTransaction(input: {
  rpcUrl: string;
  programId: PublicKey;
  signature: string;
  buyer: PublicKey;
  escrow: PublicKey;
  provider: PublicKey;
  amount: bigint;
  expectedSeconds: number;
  commitment: 'confirmed' | 'finalized';
}) {
  const connection = new Connection(input.rpcUrl, input.commitment);
  const tx = await connection.getParsedTransaction(input.signature, { commitment: input.commitment, maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) return false;
  const keys = tx.transaction.message.accountKeys;
  const buyerSigned = keys.some(k => k.pubkey.equals(input.buyer) && k.signer);
  const programPresent = keys.some(k => k.pubkey.equals(input.programId));
  const escrowPresent = keys.some(k => k.pubkey.equals(input.escrow) && k.writable);
  const opened = tx.meta?.logMessages?.some(line => line.includes('Instruction: Open')) ?? false;
  if (!buyerSigned || !programPresent || !escrowPresent || !opened) return false;
  const account = await connection.getAccountInfo(input.escrow, input.commitment);
  if (!account || !account.owner.equals(input.programId) || account.data.length < 129) return false;
  // Anchor discriminator (8), booking (32), buyer (32), provider (32), amount (8), expected_seconds (4).
  const buyerStored = new PublicKey(account.data.subarray(40, 72));
  const providerStored = new PublicKey(account.data.subarray(72, 104));
  const amountStored = account.data.readBigUInt64LE(104);
  const secondsStored = account.data.readUInt32LE(112);
  return buyerStored.equals(input.buyer) && providerStored.equals(input.provider) && amountStored === input.amount && secondsStored === input.expectedSeconds;
}

/**
 * Verifies a settlement (finalize/resolve_dispute) transaction actually happened
 * on-chain, with the exact payout amounts computed off-chain — the counterpart to
 * verifyOpenEscrowTransaction for the deposit side. Before this, confirmSettlement
 * only checked that its `signature` argument looked like a base58 string; nothing
 * proved the escrow was ever actually settled on-chain for that amount.
 *
 * settle() in the Anchor program (programs/gpu_escrow/src/lib.rs) closes the escrow
 * PDA to the buyer (`close = buyer`), so unlike the deposit path this can't re-read
 * the account's final state after the fact — the account no longer exists once
 * settlement succeeds. Instead this reads the transaction's own balance deltas,
 * which are recorded regardless of whether the account they belonged to still exists.
 */
export type ParsedSettlementTransaction = {
  meta: { err: unknown; logMessages?: string[] | null; preBalances?: number[]; postBalances?: number[] } | null;
  transaction: { message: { accountKeys: Array<{ pubkey: PublicKey; writable: boolean }> } };
};

/**
 * The decision logic, factored out from the RPC fetch so it can be unit-tested with
 * fixture transactions instead of a live Solana connection (verifyOpenEscrowTransaction
 * predates this pattern and has no equivalent test — this function is what the
 * on-chain settlement audit specifically required tests for).
 */
export function evaluateSettlementTransaction(
  tx: ParsedSettlementTransaction | null,
  input: {
    programId: PublicKey;
    escrow: PublicKey;
    buyer: PublicKey;
    provider: PublicKey;
    platform: PublicKey;
    providerLamports: bigint;
    platformLamports: bigint;
    refundLamports: bigint;
  },
): boolean {
  if (!tx || tx.meta?.err) return false;
  const keys = tx.transaction.message.accountKeys;
  const programPresent = keys.some(k => k.pubkey.equals(input.programId));
  const escrowPresent = keys.some(k => k.pubkey.equals(input.escrow) && k.writable);
  const settled = tx.meta?.logMessages?.some(line => line.includes('Instruction: Finalize') || line.includes('Instruction: ResolveDispute')) ?? false;
  if (!programPresent || !escrowPresent || !settled) return false;

  const balanceDelta = (pubkey: PublicKey): bigint | null => {
    const index = keys.findIndex(k => k.pubkey.equals(pubkey));
    const post = tx.meta?.postBalances?.[index];
    const pre = tx.meta?.preBalances?.[index];
    if (index === -1 || post === undefined || pre === undefined) return null;
    return BigInt(post) - BigInt(pre);
  };
  const providerDelta = balanceDelta(input.provider);
  const platformDelta = balanceDelta(input.platform);
  const buyerDelta = balanceDelta(input.buyer);
  if (providerDelta === null || platformDelta === null || buyerDelta === null) return false;

  // provider/platform are never the account being closed, so their balance in this
  // transaction can only change by the settlement transfer: exact match required. The
  // buyer additionally reclaims the escrow PDA's own rent-exempt reserve on top of
  // their refund when the account closes (`close = buyer`), so only a lower bound is
  // checked — a buyer can never be shorted, and the extra is provably their own rent
  // coming back, never a diversion of provider/platform funds (those are already
  // checked exactly above).
  return providerDelta === input.providerLamports && platformDelta === input.platformLamports && buyerDelta >= input.refundLamports;
}

export async function verifySettlementTransaction(input: {
  rpcUrl: string;
  commitment: 'confirmed' | 'finalized';
  programId: PublicKey;
  signature: string;
  escrow: PublicKey;
  buyer: PublicKey;
  provider: PublicKey;
  platform: PublicKey;
  providerLamports: bigint;
  platformLamports: bigint;
  refundLamports: bigint;
}): Promise<boolean> {
  const connection = new Connection(input.rpcUrl, input.commitment);
  const tx = await connection.getParsedTransaction(input.signature, { commitment: input.commitment, maxSupportedTransactionVersion: 0 });
  return evaluateSettlementTransaction(tx, input);
}
