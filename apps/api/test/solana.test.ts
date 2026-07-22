import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { bookingDigest, deriveEscrowAddresses, escrowExpiryUnix, matchesOpenEscrowAccount, openEscrowInstructionData } from '../src/solana.js';

test('booking digest is deterministic and domain separated',()=>{
  assert.equal(bookingDigest('abc').length,32);
  assert.deepEqual(bookingDigest('abc'),bookingDigest('abc'));
  assert.notDeepEqual(bookingDigest('abc'),bookingDigest('abcd'));
});

test('escrow expires exactly one hour after booking end',()=>{
  assert.equal(
    escrowExpiryUnix(new Date('2026-07-22T12:34:56.999Z')),
    1_784_727_296n,
  );
});

test('escrow expiry rejects invalid dates',()=>{
  assert.throws(()=>escrowExpiryUnix(new Date(Number.NaN)),/invalid booking end/);
});

test('deposit verification binds immutable terms and requires funded on-chain state',()=>{
  const buyer=new PublicKey(new Uint8Array(32).fill(1));
  const provider=new PublicKey(new Uint8Array(32).fill(2));
  const expected={buyer,provider,amount:123_456n,expectedSeconds:3600,expiresAtUnix:1_784_727_296n};
  const account=Buffer.alloc(138);
  buyer.toBuffer().copy(account,40);
  provider.toBuffer().copy(account,72);
  account.writeBigUInt64LE(expected.amount,104);
  account.writeUInt32LE(expected.expectedSeconds,112);
  account.writeBigInt64LE(expected.expiresAtUnix,120);
  account.writeUInt8(0,136);
  assert.equal(matchesOpenEscrowAccount(account,expected),true);
  account.writeBigInt64LE(expected.expiresAtUnix+1n,120);
  assert.equal(matchesOpenEscrowAccount(account,expected),false);
  account.writeBigInt64LE(expected.expiresAtUnix,120);
  account.writeUInt8(4,136); // Refunded
  assert.equal(matchesOpenEscrowAccount(account,expected),false);
});

test('open instruction gives Anchor the booking start and end, not a caller-selected expiry',()=>{
  const data=openEscrowInstructionData({
    booking:bookingDigest('booking-1'),amount:100n,expectedSeconds:3600,
    startsAtUnix:1_784_720_000n,expiresAtUnix:1_784_727_296n,
  });
  assert.equal(data.readBigInt64LE(52),1_784_720_000n);
  assert.equal(data.readBigInt64LE(60),1_784_723_696n);
});

test('escrow PDA is deterministic',()=>{
  const id=new PublicKey('Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m');
  const a=deriveEscrowAddresses(id,'booking-1');
  const b=deriveEscrowAddresses(id,'booking-1');
  assert.equal(a.escrow.toBase58(),b.escrow.toBase58());
  assert.notEqual(a.escrow.toBase58(),a.config.toBase58());
});
