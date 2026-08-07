import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { bookingDigest, deriveEscrowAddresses, evaluateSettlementTransaction, type ParsedSettlementTransaction } from '../src/solana.js';

test('booking digest is deterministic and domain separated',()=>{
  assert.equal(bookingDigest('abc').length,32);
  assert.deepEqual(bookingDigest('abc'),bookingDigest('abc'));
  assert.notDeepEqual(bookingDigest('abc'),bookingDigest('abcd'));
});

test('escrow PDA is deterministic',()=>{
  const id=new PublicKey('Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m');
  const a=deriveEscrowAddresses(id,'booking-1');
  const b=deriveEscrowAddresses(id,'booking-1');
  assert.equal(a.escrow.toBase58(),b.escrow.toBase58());
  assert.notEqual(a.escrow.toBase58(),a.config.toBase58());
});

// Regression for the settlement-verification audit: confirmSettlement previously
// accepted any base58-shaped string as "proof" of a real on-chain settlement, with no
// check that it corresponded to a real finalize/resolve_dispute transaction that
// actually moved the computed amounts. evaluateSettlementTransaction is the pure
// decision logic (verifySettlementTransaction is the thin RPC-fetching wrapper around
// it), tested here with fixture transactions instead of a live Solana connection.

const PROGRAM_ID = new PublicKey('Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m');
const ESCROW = new PublicKey('11111111111111111111111111111112');
const BUYER = new PublicKey('11111111111111111111111111111113');
const PROVIDER = new PublicKey('11111111111111111111111111111114');
const PLATFORM = new PublicKey('11111111111111111111111111111115');
const OTHER_PROGRAM = new PublicKey('11111111111111111111111111111116');

const EXPECTED = { providerLamports: 950_000n, platformLamports: 50_000n, refundLamports: 100_000n };
const RENT_RESERVE = 890_880n; // arbitrary but realistic small rent-exempt reserve the closed escrow returns to the buyer on top of its refund

function fixture(overrides: {
  err?: unknown;
  logMessages?: string[];
  keys?: Array<{ pubkey: PublicKey; writable: boolean }>;
  deltas?: Partial<{ provider: bigint; platform: bigint; buyer: bigint }>;
  omitBalances?: boolean;
}): ParsedSettlementTransaction {
  const keys = overrides.keys ?? [
    { pubkey: PROGRAM_ID, writable: false },
    { pubkey: ESCROW, writable: true },
    { pubkey: PROVIDER, writable: true },
    { pubkey: PLATFORM, writable: true },
    { pubkey: BUYER, writable: true },
  ];
  const deltas = {
    provider: overrides.deltas?.provider ?? EXPECTED.providerLamports,
    platform: overrides.deltas?.platform ?? EXPECTED.platformLamports,
    buyer: overrides.deltas?.buyer ?? (EXPECTED.refundLamports + RENT_RESERVE),
  };
  const base = 1_000_000n;
  const preBalances = keys.map(() => Number(base));
  const postBalances = keys.map(k => {
    if (k.pubkey.equals(PROVIDER)) return Number(base + deltas.provider);
    if (k.pubkey.equals(PLATFORM)) return Number(base + deltas.platform);
    if (k.pubkey.equals(BUYER)) return Number(base + deltas.buyer);
    return Number(base);
  });
  return {
    meta: {
      err: overrides.err ?? null,
      logMessages: overrides.logMessages ?? ['Program log: Instruction: Finalize'],
      ...(overrides.omitBalances ? {} : { preBalances, postBalances }),
    },
    transaction: { message: { accountKeys: keys } },
  };
}

const baseInput = { programId: PROGRAM_ID, escrow: ESCROW, buyer: BUYER, provider: PROVIDER, platform: PLATFORM, ...EXPECTED };

test('1) a valid Finalize transaction with exact payout amounts is accepted', () => {
  assert.equal(evaluateSettlementTransaction(fixture({}), baseInput), true);
});

test('2) a valid ResolveDispute transaction is accepted (the admin dispute-resolution path)', () => {
  assert.equal(evaluateSettlementTransaction(fixture({ logMessages: ['Program log: Instruction: ResolveDispute'] }), baseInput), true);
});

test('3) a null transaction (signature not found on-chain) is rejected', () => {
  assert.equal(evaluateSettlementTransaction(null, baseInput), false);
});

test('4) a transaction that failed on-chain (meta.err set) is rejected', () => {
  assert.equal(evaluateSettlementTransaction(fixture({ err: { InstructionError: [0, 'Custom'] } }), baseInput), false);
});

test('5) a transaction that never invoked the escrow program is rejected', () => {
  const keys = [{ pubkey: OTHER_PROGRAM, writable: false }, { pubkey: PROVIDER, writable: true }, { pubkey: PLATFORM, writable: true }, { pubkey: BUYER, writable: true }];
  assert.equal(evaluateSettlementTransaction(fixture({ keys }), baseInput), false);
});

test('6) a transaction where the escrow account is not present/writable is rejected', () => {
  const keys = [{ pubkey: PROGRAM_ID, writable: false }, { pubkey: PROVIDER, writable: true }, { pubkey: PLATFORM, writable: true }, { pubkey: BUYER, writable: true }];
  assert.equal(evaluateSettlementTransaction(fixture({ keys }), baseInput), false);
});

test('7) a transaction that only opened the escrow (never settled it) is rejected', () => {
  assert.equal(evaluateSettlementTransaction(fixture({ logMessages: ['Program log: Instruction: Open'] }), baseInput), false);
});

test('8) the provider being paid less than the computed amount is rejected, not silently accepted', () => {
  assert.equal(evaluateSettlementTransaction(fixture({ deltas: { provider: EXPECTED.providerLamports - 1n } }), baseInput), false);
});

test('9) the provider being paid MORE than the computed amount is also rejected (must match exactly)', () => {
  assert.equal(evaluateSettlementTransaction(fixture({ deltas: { provider: EXPECTED.providerLamports + 1n } }), baseInput), false);
});

test('10) the platform commission being short-paid is rejected', () => {
  assert.equal(evaluateSettlementTransaction(fixture({ deltas: { platform: EXPECTED.platformLamports - 1n } }), baseInput), false);
});

test('11) the buyer receiving less than their computed refund is rejected (a buyer can never be shorted)', () => {
  assert.equal(evaluateSettlementTransaction(fixture({ deltas: { buyer: EXPECTED.refundLamports - 1n } }), baseInput), false);
});

test('12) the buyer receiving exactly the refund plus the escrow account\'s reclaimed rent is accepted', () => {
  assert.equal(evaluateSettlementTransaction(fixture({ deltas: { buyer: EXPECTED.refundLamports + RENT_RESERVE } }), baseInput), true);
});

test('13) missing pre/post balance data is rejected rather than treated as a zero delta', () => {
  assert.equal(evaluateSettlementTransaction(fixture({ omitBalances: true }), baseInput), false);
});

test('14) a full refund (zero payable) still requires the buyer to receive at least the full refund', () => {
  const fullRefundInput = { ...baseInput, providerLamports: 0n, platformLamports: 0n, refundLamports: 1_000_000n };
  const tx = fixture({ deltas: { provider: 0n, platform: 0n, buyer: 1_000_000n + RENT_RESERVE } });
  assert.equal(evaluateSettlementTransaction(tx, fullRefundInput), true);
  const shorted = fixture({ deltas: { provider: 0n, platform: 0n, buyer: 999_999n } });
  assert.equal(evaluateSettlementTransaction(shorted, fullRefundInput), false);
});
