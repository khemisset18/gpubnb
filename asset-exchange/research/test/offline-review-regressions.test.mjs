import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {dataHash} from '../src/offline-data.mjs';
import {replayOfflineProtocol} from '../src/offline-protocol.mjs';
import {createOfflineProtocolStore, readOfflineProtocolStore, appendOfflineProtocolEvent} from '../src/offline-protocol-store.mjs';
import {hash, configFixture, eventFixture, preparedFixture, lockedFixture, claimedFixture, reportsFixture, reconcileFixture} from './protocol-fixtures.mjs';

test('closed cancellation is not rewritten into expiry or an operational hold', () => {
  const c = configFixture(), events = [...preparedFixture(c), eventFixture(c, 'CANCEL', {}, 103)];
  for (const e of [eventFixture(c, 'CLOCK', {}, 2000), eventFixture(c, 'UNAVAILABLE', {reason: 'NETWORK_UNAVAILABLE'}, 104),
    eventFixture(c, 'RPC_ERROR', {leg: 'A', operationClass: 'READ', requestDigest: hash('read error')}, 104)]) {
    assert.throws(() => replayOfflineProtocol(c, [...events, e]), /closed/);
  }
});
test('a closed claimed trade does not reopen merely because the clock advances', () => {
  const c = configFixture(), events = [...claimedFixture(c), reconcileFixture(c, 'CLAIMED', 'CLAIMED')];
  assert.throws(() => replayOfflineProtocol(c, [...events, eventFixture(c, 'CLOCK', {}, 2000)]), /closed/);
});
test('fresh arrival time cannot disguise older per-source observation time', () => {
  const c = configFixture(), events = lockedFixture(c).slice(0, 4);
  const reports = reportsFixture(c, 'A', 'LOCKED', 102);
  const state = replayOfflineProtocol(c, [...events, eventFixture(c, 'LOCK_CONFIRMED', {leg: 'A', reports}, 104)]);
  assert.equal(state.mode, 'HOLD'); assert.equal(state.legs.A.confirmed, false); assert.ok(state.reasons.includes('REGRESSING_SOURCE_OBSERVATION'));
});
test('tip regression requires a new epoch even when fabricated depth still reaches the minimum', () => {
  const c = configFixture(), events = lockedFixture(c).slice(0, 4);
  events[3].payload.reports.forEach(r => {r.tipHeight = 110;});
  const state = replayOfflineProtocol(c, [...events, eventFixture(c, 'LOCK_CONFIRMED', {leg: 'A', reports: reportsFixture(c, 'A', 'LOCKED', 104)}, 104)]);
  assert.equal(state.mode, 'HOLD'); assert.ok(state.reasons.includes('REGRESSING_CHAIN_TIP_REQUIRES_EPOCH'));
});
test('a changed inclusion block cannot be accepted under the old epoch', () => {
  const c = configFixture(), events = lockedFixture(c).slice(0, 4), reports = reportsFixture(c, 'A', 'LOCKED', 104);
  reports.forEach(r => {r.blockHash = hash('replacement block');});
  const state = replayOfflineProtocol(c, [...events, eventFixture(c, 'LOCK_CONFIRMED', {leg: 'A', reports}, 104)]);
  assert.equal(state.mode, 'HOLD'); assert.ok(state.reasons.includes('INCLUSION_CHANGED_WITHOUT_EPOCH'));
});
test('source identities resembling object properties cannot corrupt persisted high-water state', () => {
  const c = configFixture(); c.legs.A.policy.sources[0].id = 'constructor'; c.legs.A.policy.sources[1].id = 'prototype';
  const state = replayOfflineProtocol(c, lockedFixture(c));
  assert.equal(state.phase, 'B_CONFIRMED'); assert.match(dataHash(state), /^[a-f0-9]{64}$/);
});
test('disappeared locks preserve the previous evidence and require explicit epoch reconciliation', () => {
  const c = configFixture(), events = lockedFixture(c), before = replayOfflineProtocol(c, events);
  const after = replayOfflineProtocol(c, [...events, reconcileFixture(c, 'UNFUNDED', 'UNFUNDED')]);
  assert.equal(after.mode, 'HOLD'); assert.equal(after.legs.A.lockReceipt, before.legs.A.lockReceipt); assert.equal(after.legs.A.everExposed, true);
});
test('a fresh contradictory reconciliation cannot rewrite closed claims into refunds without reorg epochs', () => {
  const c = configFixture(), events = [...claimedFixture(c), reconcileFixture(c, 'CLAIMED', 'CLAIMED')];
  const state = replayOfflineProtocol(c, [...events, reconcileFixture(c, 'REFUNDED', 'REFUNDED', 121)]);
  assert.equal(state.mode, 'INCIDENT'); assert.equal(state.legs.A.resolution, 'CLAIMED'); assert.ok(state.reasons.includes('RESOLUTION_CHANGED_WITHOUT_EPOCH'));
});
function setup(t) {
  const root = mkdtempSync(join(resolve(process.cwd()), '.offline-review-test-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const config = configFixture(), directory = join(root, 'store'), created = createOfflineProtocolStore(directory, config);
  return {config, directory, tradeId: config.tradeId, checkpoint: created.checkpoint};
}
const append = (f, event, cp = f.checkpoint) => appendOfflineProtocolEvent({directory: f.directory, tradeId: f.tradeId, expectedCheckpoint: cp, event});
test('stale writers fail before archiving uncommitted events', t => {
  const f = setup(t); append(f, preparedFixture(f.config)[0]);
  const e = eventFixture(f.config, 'CLOCK', {}, 104);
  assert.throws(() => append(f, e), /compare-and-swap/);
  assert.equal(existsSync(join(f.directory, 'events', dataHash(e) + '.json')), false);
});
test('an interrupted protocol writer lock is never stolen or ignored', t => {
  const f = setup(t), path = join(f.directory, 'protocol-writer.lock'); writeFileSync(path, 'interrupted', {mode: 0o600});
  assert.throws(() => append(f, preparedFixture(f.config)[0]), /protocol writer lock/); assert.equal(readFileSync(path, 'utf8'), 'interrupted');
});
const moduleUrl = new URL('../src/offline-protocol-store.mjs', import.meta.url).href;
test('actual SIGKILL in a partial journal write preserves torn bytes and both recovery locks', t => {
  const f = setup(t), event = preparedFixture(f.config)[0], file = join(f.directory, 'journal.ndjson'), before = readFileSync(file);
  const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const real=fs.writeSync;fs.writeSync=function(fd,b,o,n,p){if(Buffer.isBuffer(b)&&b.includes(Buffer.from('"recordHash"'))){real(fd,b,o,19,p);process.kill(process.pid,'SIGKILL');}return real(...arguments);};
syncBuiltinESMExports();const {appendOfflineProtocolEvent}=await import(${JSON.stringify(moduleUrl)});
appendOfflineProtocolEvent(${JSON.stringify({directory:f.directory,tradeId:f.tradeId,expectedCheckpoint:f.checkpoint,event})});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8', timeout: 10000});
  assert.equal(child.signal, 'SIGKILL', child.stderr); const torn = readFileSync(file); assert.equal(torn.length, before.length + 19);
  assert.throws(() => readOfflineProtocolStore({directory:f.directory,tradeId:f.tradeId,minimumCheckpoint:f.checkpoint}), /torn journal tail/);
  assert.equal(existsSync(join(f.directory, 'writer.lock')), true); assert.equal(existsSync(join(f.directory, 'protocol-writer.lock')), true);
  assert.deepEqual(readFileSync(file), torn);
});
test('actual SIGKILL after journal fsync recovers committed state but forbids lock stealing', t => {
  const f = setup(t), event = preparedFixture(f.config)[0];
  const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const real=fs.unlinkSync;fs.unlinkSync=function(path){if(path.endsWith('/writer.lock'))process.kill(process.pid,'SIGKILL');return real(...arguments);};
syncBuiltinESMExports();const {appendOfflineProtocolEvent}=await import(${JSON.stringify(moduleUrl)});
appendOfflineProtocolEvent(${JSON.stringify({directory:f.directory,tradeId:f.tradeId,expectedCheckpoint:f.checkpoint,event})});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8', timeout: 10000});
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const recovered = readOfflineProtocolStore({directory:f.directory,tradeId:f.tradeId,minimumCheckpoint:f.checkpoint});
  assert.equal(recovered.state.phase, 'TERMS_VALIDATED'); assert.equal(recovered.checkpoint.sequence, 2);
  assert.throws(() => append(f, preparedFixture(f.config)[1], recovered.checkpoint), /writer lock/);
});
