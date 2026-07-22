import assert from 'node:assert/strict';
import test from 'node:test';
import {encode58,formatSol,walletProofEndpoint} from '../apps/web/app.js';
test('encode58 handles leading zero bytes and known values',()=>{assert.equal(encode58(new Uint8Array()),'');assert.equal(encode58(new Uint8Array([0])),'1');assert.equal(encode58(new Uint8Array([0,0,1])),'112');assert.equal(encode58(new TextEncoder().encode('Hello World')),'JxF12TrwUP45BMd')});
test('formatSol uses integer arithmetic and rejects unsafe API values',()=>{assert.equal(formatSol('1000000000'),'1 SOL');assert.equal(formatSol('1250000000'),'1,25 SOL');assert.equal(formatSol('9007199254740993000000000'),'9 007 199 254 740 993 SOL');assert.equal(formatSol('-1'),null);assert.equal(formatSol('bad'),null);assert.equal(formatSol(1_000_000_000),null)});
test('an authenticated account links Phantom instead of creating a duplicate account',()=>{assert.equal(walletProofEndpoint(true),'/auth/wallet/link');assert.equal(walletProofEndpoint(false),'/auth/verify')});
