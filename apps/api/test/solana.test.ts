import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { bookingDigest, deriveEscrowAddresses } from '../src/solana.js';

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
