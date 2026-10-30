import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, chmodSync, symlinkSync, linkSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {canonical, dataHash} from '../src/offline-data.mjs';
import {emptyOfflineCheckpoint} from '../src/offline-journal.mjs';
import {replayOfflineProtocol} from '../src/offline-protocol.mjs';
import {createOfflineProtocolStore, readOfflineProtocolStore, appendOfflineProtocolEvent} from '../src/offline-protocol-store.mjs';
import {hash, configFixture, eventFixture, preparedFixture, claimedFixture, reconcileFixture} from './protocol-fixtures.mjs';

function setup(t) {
  const root = mkdtempSync(join(resolve(process.cwd()), '.offline-protocol-test-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const directory = join(root, 'private'), config = configFixture(), created = createOfflineProtocolStore(directory, config);
  return {directory, tradeId: config.tradeId, config, checkpoint: created.checkpoint};
}
const read = (f, cp = f.checkpoint) => readOfflineProtocolStore({directory: f.directory, tradeId: f.tradeId, minimumCheckpoint: cp});
const append = (f, event, expectedCheckpoint = f.checkpoint) => appendOfflineProtocolEvent({directory: f.directory, tradeId: f.tradeId, expectedCheckpoint, event});
const blob = (f, event) => join(f.directory, 'events', dataHash(event) + '.json');
const moduleUrl = new URL('../src/offline-protocol-store.mjs', import.meta.url).href;
const childCode = args => `import {appendOfflineProtocolEvent} from ${JSON.stringify(moduleUrl)}; try {console.log(JSON.stringify(appendOfflineProtocolEvent(${JSON.stringify(args)})));} catch(e) {console.error(e.message); process.exit(12);}`;
test('durable public event replay reproduces full model state and independent checkpoint after reopen', t => {
  const f = setup(t), events = [...claimedFixture(f.config), reconcileFixture(f.config, 'CLAIMED', 'CLAIMED')]; let cp = f.checkpoint;
  for (const e of events) { const result = append(f, e, cp); assert.equal(result.appended, true); cp = result.checkpoint; }
  const recovered = read(f, cp); assert.deepEqual(recovered.state, replayOfflineProtocol(f.config, events));
  assert.equal(recovered.modelStateDigest, dataHash(recovered.state)); assert.equal(recovered.state.phase, 'RECONCILED_CLAIMS_IN_MODEL');
  assert.equal(recovered.authenticationVerified, false); assert.equal(recovered.realRecoveryVerified, false); assert.deepEqual(recovered.executableOperations, []);
  assert.equal(statSync(join(f.directory, 'config.json')).mode & 0o777, 0o600); assert.equal(statSync(blob(f, events[0])).mode & 0o777, 0o600);
});
test('duplicate event is effect-free; conflicting replay and stale new event fail', t => {
  const f = setup(t), events = preparedFixture(f.config), first = append(f, events[0]);
  const duplicate = append(f, events[0]); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.appended, false);
  assert.deepEqual(duplicate.checkpoint, first.checkpoint);
  assert.throws(() => append(f, {...events[0], payload: {validationReceiptDigest: hash('changed')}}), /conflicting protocol/);
  assert.throws(() => append(f, events[1]), /compare-and-swap/); assert.equal(read(f).events.length, 1);
});
test('real child writer exits after fsync; a new reader replays the same state with no process memory', t => {
  const f = setup(t), event = preparedFixture(f.config)[0], args = {directory: f.directory, tradeId: f.tradeId, expectedCheckpoint: f.checkpoint, event};
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode(args) + '\nprocess.exit(19);'], {encoding: 'utf8'});
  assert.equal(child.status, 19, child.stderr); const saved = JSON.parse(child.stdout);
  assert.deepEqual(read(f, saved.checkpoint).state, saved.state); assert.equal(read(f).state.phase, 'TERMS_VALIDATED');
});
test('two real protocol writers cannot both commit from one head', async t => {
  const f = setup(t), base = preparedFixture(f.config)[0];
  const run = id => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode({directory: f.directory, tradeId: f.tradeId, expectedCheckpoint: f.checkpoint, event: {...base, id}})]);
    let out = '', err = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
    child.once('error', reject); child.once('exit', code => resolveResult({code, out, err}));
  });
  const results = await Promise.all([run('writer-event:1'), run('writer-event:2')]);
  assert.equal(results.filter(r => r.code === 0).length, 1, JSON.stringify(results)); assert.equal(results.filter(r => r.code === 12).length, 1, JSON.stringify(results));
  assert.equal(read(f).events.length, 1);
});
test('missing or changed event archive fails closed without editing the journal', t => {
  const f = setup(t), event = preparedFixture(f.config)[0], saved = append(f, event), path = blob(f, event), bytes = readFileSync(path), journal = readFileSync(join(f.directory, 'journal.ndjson'));
  unlinkSync(path); assert.throws(() => read(f, saved.checkpoint), /ENOENT/);
  writeFileSync(path, JSON.stringify(canonical({...event, at: event.at + 1})) + '\n', {mode: 0o600});
  assert.throws(() => read(f, saved.checkpoint), /archive digest/); assert.deepEqual(readFileSync(join(f.directory, 'journal.ndjson')), journal);
  writeFileSync(path, bytes); assert.deepEqual(read(f, saved.checkpoint).events, [event]);
});
test('noncanonical config, config rebinding and an empty independent checkpoint cannot be adopted', t => {
  const f = setup(t), path = join(f.directory, 'config.json'), bytes = readFileSync(path);
  writeFileSync(path, '{"schemaVersion":1,' + bytes.toString().slice(1)); assert.throws(() => read(f), /noncanonical/);
  writeFileSync(path, JSON.stringify(canonical({...f.config, rolesDigest: hash('changed roles')})) + '\n');
  assert.throws(() => read(f), /configuration not bound/);
  writeFileSync(path, bytes); assert.throws(() => read(f, emptyOfflineCheckpoint(f.tradeId)), /nonempty/);
});
test('truncation, torn tail, stale lock and partial orphan archive require explicit recovery', t => {
  const f = setup(t), event = preparedFixture(f.config)[0], path = blob(f, event);
  // Crash before journal commit: the journal ignores this orphan but a retry must not overwrite partial bytes.
  writeFileSync(path, '{"schemaVersion":', {mode: 0o600}); assert.equal(read(f).events.length, 0);
  assert.throws(() => append(f, event)); assert.equal(readFileSync(path, 'utf8'), '{"schemaVersion":');
  unlinkSync(path); const saved = append(f, event), journalPath = join(f.directory, 'journal.ndjson'), journal = readFileSync(journalPath);
  writeFileSync(journalPath, journal.toString().split('\n')[0] + '\n'); assert.throws(() => read(f, saved.checkpoint), /rollback\/truncation/);
  writeFileSync(journalPath, journal); appendFileSync(journalPath, '{'); assert.throws(() => read(f, saved.checkpoint), /torn journal tail/);
  writeFileSync(journalPath, journal); writeFileSync(join(f.directory, 'writer.lock'), 'interrupted writer', {mode: 0o600});
  assert.throws(() => append(f, preparedFixture(f.config)[1], saved.checkpoint), /no automatic stale-lock removal/);
});
test('broad permissions, hardlinks, symlinks and secret/executable fields are rejected', t => {
  const f = setup(t), e = preparedFixture(f.config)[0], saved = append(f, e), path = blob(f, e), alias = join(f.directory, 'alias');
  chmodSync(path, 0o644); assert.throws(() => read(f, saved.checkpoint), /private bounded/); chmodSync(path, 0o600);
  linkSync(path, alias); assert.throws(() => read(f), /single-link/); unlinkSync(alias);
  const bytes = readFileSync(path); unlinkSync(path); writeFileSync(alias, bytes, {mode: 0o600}); symlinkSync(alias, path); assert.throws(() => read(f));
  unlinkSync(path); writeFileSync(path, bytes, {mode: 0o600});
  for (const field of ['preimage', 'privateKey', 'transactionHex', 'signature']) {
    const bad = eventFixture(f.config, 'CLOCK', {[field]: 'synthetic but forbidden'}, 104);
    assert.throws(() => append(f, bad, saved.checkpoint), /unexpected/);
  }
  assert.equal(read(f).events.length, 1);
});
