import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {dataHash} from '../src/offline-data.mjs';
import {offlineChainRequirements, validateOfflineChainDescriptor, validateOfflineChainPlan, assessOfflinePair} from '../src/chain-boundaries.mjs';
import {hash} from './protocol-fixtures.mjs';

const assets = ['BTC', 'DOGE', 'LTC', 'BCH', 'XMR', 'SOL'];
function descriptor(asset) {
  const r = offlineChainRequirements(asset);
  return {schemaVersion: 1, asset, network: 'synthetic-offline', genesis: hash(asset + ':synthetic genesis'),
    sourceCommit: asset === 'DOGE' ? 'e0a1c157791544e818c901bd9341896965afbf9d' : 'a'.repeat(40),
    mechanism: r.mechanism, signingDomain: r.signingDomain, feeUnit: r.feeUnit, profileDigest: hash(asset + ':profile')};
}
function plan(d) {
  let details;
  if (d.asset === 'XMR') details = {protocolFamily: 'SEPARATELY_REVIEWED_ADAPTOR_SWAP', protocolReviewDigest: hash('protocol'),
    crossCurveProofReceiptDigest: hash('DLEQ'), adaptorTranscriptDigest: hash('adaptor'), keyShareCommitmentDigest: hash('share'),
    refundTranscriptDigest: hash('refund transcript'), keyImageWatchDigest: hash('key image'), rescanCheckpointDigest: hash('rescan')};
  else if (d.asset === 'SOL') details = {programPurpose: 'ATOMIC_SWAP', programIdHex: hash('unimplemented program'), accountOwnerHex: hash('unimplemented program'),
    escrowPdaHex: hash('synthetic PDA'), pdaSeedsDigest: hash('seeds'), authorityRolesDigest: hash('authorities'), accountLayoutDigest: hash('layout'),
    commitmentHex: hash('commitment'), expiryDomain: 'UNIX_SECONDS_CLOCK', expiryValue: '3000', observationCommitment: 'finalized', rentReserveAtomic: '100', priorityFeeBudgetAtomic: '5'};
  else {
    // OP_1 is deliberately NOT an HTLC. Passing this boundary must never imply script validity.
    const scriptHex = '51', sha = createHash('sha256').update(Buffer.from(scriptHex, 'hex')).digest();
    const outputScriptHex = ['BTC', 'LTC'].includes(d.asset) ? '0020' + sha.toString('hex') : 'a914' + createHash('ripemd160').update(sha).digest('hex') + '87';
    details = {fundingOutpoint: {txid: hash('nonexistent outpoint'), vout: 0}, scriptHex, outputScriptHex,
      claimRoleDigest: hash('claim role'), refundRoleDigest: hash('refund role'), commitmentHex: hash('commitment'),
      signatureHashType: d.asset === 'BCH' ? 0x41 : 1, refundLock: 1351, lockDomain: 'HEIGHT', sequence: 0xfffffffe};
  }
  return {schemaVersion: 1, termsDigest: hash('terms'), descriptorDigest: dataHash(d), recoveryDigest: hash('recovery'),
    amountAtomic: '100000', feeBudgetAtomic: '10', destinationDigest: hash('destination'), details};
}
const check = (d, p) => validateOfflineChainPlan(d, p, dataHash(p));
test('all six explicit interfaces remain unqualified even when their structure and digest bind', () => {
  for (const asset of assets) {
    const d = descriptor(asset), p = plan(d), result = check(d, p);
    assert.equal(result.asset, asset); assert.equal(result.qualified, false); assert.equal(result.simulationOnly, true);
    assert.equal(result.nativeQualification, 'NOT TESTED'); assert.equal(result.contractSemanticsVerified, false);
    assert.equal(result.signatureVerified, false); assert.equal(result.recoveryVerified, false); assert.equal(result.chainFactsVerified, false);
    assert.equal(result.financialExecutionAllowed, false); assert.deepEqual(result.executableOperations, []); assert.ok(Object.isFrozen(result));
  }
});
test('family, network, source, fee unit and signing domain substitutions reject', () => {
  for (const asset of assets) {
    for (const [field, value] of [['network', 'mainnet'], ['mechanism', 'BITCOIN_HTLC'], ['signingDomain', 'LEGACY'], ['feeUnit', 'FLOAT_COINS'], ['sourceCommit', 'unversioned']]) {
      const d = descriptor(asset); d[field] = value; assert.throws(() => validateOfflineChainDescriptor(d));
    }
  }
  const d = descriptor('DOGE'); d.sourceCommit = 'b'.repeat(40); assert.throws(() => validateOfflineChainDescriptor(d), /D0 source/);
  assert.throws(() => offlineChainRequirements('ETH')); assert.throws(() => offlineChainRequirements('__proto__'));
});
test('expected digest separately binds amount, destination, recovery and terms even when still well-typed', () => {
  const d = descriptor('DOGE'), p = plan(d), expected = dataHash(p);
  for (const [field, value] of [['amountAtomic', '200000'], ['destinationDigest', hash('wrong destination')], ['termsDigest', hash('wrong terms')], ['recoveryDigest', hash('wrong recovery')]]) {
    assert.throws(() => validateOfflineChainPlan(d, {...p, [field]: value}, expected), /independently expected/);
  }
  assert.throws(() => validateOfflineChainPlan(d, p, 'not a digest'));
});
test('integer strings, bounded amounts and fee/rent reserves reject float, negative, overflow and excess', () => {
  for (const asset of assets) {
    const d = descriptor(asset);
    for (const amount of [1, true, '1.1', '-1', '01', '0', (1n << 64n).toString()]) assert.throws(() => check(d, {...plan(d), amountAtomic: amount}));
    for (const fee of ['0', '100000', '100001']) assert.throws(() => check(d, {...plan(d), feeBudgetAtomic: fee}));
  }
  const d = descriptor('SOL'), p = plan(d); p.details.priorityFeeBudgetAtomic = '11'; assert.throws(() => check(d, p), /priority fee/);
  p.details.priorityFeeBudgetAtomic = '5'; p.details.rentReserveAtomic = '99999'; assert.throws(() => check(d, p), /rent and fee/);
});
test('actual contract hashes bind P2WSH separately from legacy P2SH without interpreting script semantics', () => {
  for (const asset of ['BTC', 'DOGE', 'LTC', 'BCH']) {
    const d = descriptor(asset), p = plan(d); p.details.scriptHex = '52'; assert.throws(() => check(d, p), /hash mismatch/);
    const q = plan(d); q.details.outputScriptHex = plan(descriptor(['BTC', 'LTC'].includes(asset) ? 'DOGE' : 'BTC')).details.outputScriptHex;
    assert.throws(() => check(d, q), /hash mismatch/);
    const oversized = plan(d); oversized.details.scriptHex = '51'.repeat(521); assert.throws(() => check(d, oversized), /bounded public/);
  }
});
test('BCH ForkID bit and legacy/SegWit descriptors cannot be silently interchanged', () => {
  for (const asset of ['BTC', 'DOGE', 'LTC', 'BCH']) {
    const d = descriptor(asset), p = plan(d); p.details.signatureHashType = asset === 'BCH' ? 1 : 0x41;
    assert.throws(() => check(d, p), /signature hash domain/);
  }
  const doge = descriptor('DOGE'), btc = descriptor('BTC'); assert.throws(() => check(btc, plan(doge)), /chain\/profile identity/);
  const ltc = descriptor('LTC'); ltc.mechanism = 'MWEB'; assert.throws(() => validateOfflineChainDescriptor(ltc), /mechanism/);
});
test('UTXO identity, distinct roles, lock domain and nonfinal sequence are independently required', () => {
  const d = descriptor('DOGE');
  for (const mutate of [p => {p.details.fundingOutpoint.txid = '0'.repeat(64);}, p => {p.details.fundingOutpoint.vout = 0xffffffff;},
    p => {p.details.claimRoleDigest = p.details.refundRoleDigest;}, p => {p.details.sequence = 0xffffffff;},
    p => {p.details.lockDomain = 'UNIX_TIME';}, p => {p.details.refundLock = 0;}, p => {p.details.refundLock = 0x100000000;}]) {
    const p = plan(d); mutate(p); assert.throws(() => check(d, p));
  }
});
test('Monero requires a separate adaptor/proof/recovery envelope and excludes a fake script HTLC', () => {
  const d = descriptor('XMR');
  const fake = plan(d); fake.details = plan(descriptor('DOGE')).details; assert.throws(() => check(d, fake));
  const p = plan(d); delete p.details.keyImageWatchDigest; assert.throws(() => check(d, p));
  const q = plan(d); q.details.protocolFamily = 'BITCOIN_HTLC'; assert.throws(() => check(d, q), /Monero/);
});
test('Solana rental purpose, wrong owner, implicit expiry and weaker commitment cannot enter swap envelope', () => {
  const d = descriptor('SOL');
  for (const [field, value] of [['programPurpose', 'RENTAL_ESCROW'], ['accountOwnerHex', hash('wrong owner')], ['escrowPdaHex', hash('unimplemented program')],
    ['observationCommitment', 'confirmed'], ['observationCommitment', 'processed'], ['expiryDomain', 'SLOT'], ['expiryValue', '0'], ['expiryValue', (1n << 63n).toString()]]) {
    const p = plan(d); p.details[field] = value; assert.throws(() => check(d, p));
  }
});
test('no key, preimage, signature, transaction bytes or caller qualification flag is an accepted field', () => {
  for (const asset of assets) {
    const d = descriptor(asset);
    for (const field of ['privateKey', 'preimage', 'signature', 'transactionHex', 'qualified']) {
      const p = {...plan(d), [field]: 'forbidden synthetic data'}; assert.throws(() => check(d, p), /unexpected/);
    }
  }
});
test('every ordered direction requires its own review; zero of thirty directions becomes qualified', () => {
  let count = 0;
  for (const a of assets) for (const b of assets.filter(asset => asset !== a)) {
    const da = descriptor(a), db = descriptor(b), review = {schemaVersion: 1, descriptorADigest: dataHash(da), descriptorBDigest: dataHash(db), protocolReviewDigest: hash(a + '->' + b), recoveryReviewDigest: hash('recovery review')};
    const result = assessOfflinePair(da, db, review); assert.equal(result.qualificationStatus, 'BLOCKED'); assert.equal(result.qualifiedDirections, 0);
    assert.equal(result.financialExecutionAllowed, false); assert.deepEqual(result.executableOperations, []); assert.ok(result.missingEvidence.length > 0);
    assert.throws(() => assessOfflinePair(db, da, review), /ordered pair/); count++;
  }
  assert.equal(count, 30);
});
