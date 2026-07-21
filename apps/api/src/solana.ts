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
