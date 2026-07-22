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
export const ESCROW_REFUND_GRACE_SECONDS = 3_600n;

/** The on-chain refund deadline is an immutable business term. */
export function escrowExpiryUnix(bookingEndsAt: Date): bigint {
  const endsAtMs = bookingEndsAt.getTime();
  if (!Number.isFinite(endsAtMs)) throw new Error('invalid booking end');
  return BigInt(Math.floor(endsAtMs / 1_000)) + ESCROW_REFUND_GRACE_SECONDS;
}

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

export function openEscrowInstructionData(input: {
  booking: Buffer;
  amount: bigint;
  expectedSeconds: number;
  startsAtUnix: bigint;
  expiresAtUnix: bigint;
}): Buffer {
  if (input.booking.length !== 32) throw new Error('booking digest must be 32 bytes');
  const bookingEndsAtUnix = input.expiresAtUnix - ESCROW_REFUND_GRACE_SECONDS;
  return Buffer.concat([
    discriminator('open'), input.booking, u64le(input.amount), u32le(input.expectedSeconds),
    i64le(input.startsAtUnix), i64le(bookingEndsAtUnix),
  ]);
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

export function matchesOpenEscrowAccount(data: Buffer, expected: {
  buyer: PublicKey;
  provider: PublicKey;
  amount: bigint;
  expectedSeconds: number;
  expiresAtUnix: bigint;
}): boolean {
  if (data.length < 137) return false;
  const buyerStored = new PublicKey(data.subarray(40, 72));
  const providerStored = new PublicKey(data.subarray(72, 104));
  return buyerStored.equals(expected.buyer)
    && providerStored.equals(expected.provider)
    && data.readBigUInt64LE(104) === expected.amount
    && data.readUInt32LE(112) === expected.expectedSeconds
    && data.readBigInt64LE(120) === expected.expiresAtUnix
    && data.readUInt8(136) === 0; // EscrowState::Funded
}

export async function buildOpenEscrowTransaction(input: {
  rpcUrl: string;
  programId: PublicKey;
  buyer: PublicKey;
  provider: PublicKey;
  bookingId: string;
  amount: bigint;
  expectedSeconds: number;
  startsAtUnix: bigint;
  commitment: 'confirmed' | 'finalized';
  expiresAtUnix: bigint;
}) {
  const { booking, config, escrow } = deriveEscrowAddresses(input.programId, input.bookingId);
  const data = openEscrowInstructionData({ booking, ...input });
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
  expiresAtUnix: bigint;
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
  if (!account || !account.owner.equals(input.programId)) return false;
  // Anchor discriminator (8), booking (32), buyer (32), provider (32), amount (8),
  // expected_seconds (4), valid_seconds (4), expires_at (8).
  return matchesOpenEscrowAccount(account.data, input);
}
