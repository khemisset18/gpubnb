import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, appendFileSync, writeFileSync, readFileSync, chmodSync, symlinkSync, unlinkSync, linkSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {dataHash, canonical} from '../src/offline-data.mjs';
import {createOfflineJournal, appendOfflineJournal, readOfflineJournal, exportOfflineRecovery, emptyOfflineCheckpoint} from '../src/offline-journal.mjs';
const tradeId = 'trade-fixture:1', termsDigest = 'a'.repeat(64);
const event = id => ({schemaVersion: 1, id, tradeId, type: 'TERMS_BOUND', payload: {termsDigest}});
function setup(t) {
  const root = mkdtempSync(join(resolve(process.cwd()), '.offline-journal-test-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  const directory = join(root, 'private'); const {checkpoint} = createOfflineJournal(directory, tradeId);
  return {directory, tradeId, checkpoint, file: join(directory, 'journal.ndjson')};
}
const moduleUrl = new URL('../src/offline-journal.mjs', import.meta.url).href;
const childCode = args => `import {appendOfflineJournal} from ${JSON.stringify(moduleUrl)}; try {const r = appendOfflineJournal(${JSON.stringify(args)}); console.log(JSON.stringify(r));} catch(e) {console.error(e.message); process.exit(12);}`;
test('journal persists exact digests and recovery export without any executable capability', t => {
  const f = setup(t); const saved = appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: event('event-0001')});
  assert.equal(saved.appended, true); assert.equal(saved.checkpoint.sequence, 1);
  const read = readOfflineJournal({...f, minimumCheckpoint: saved.checkpoint}); assert.deepEqual(read.events, [event('event-0001')]);
  const bundle = exportOfflineRecovery({...f, minimumCheckpoint: saved.checkpoint});
  assert.equal(bundle.envelopeDigest, dataHash(bundle.envelope)); assert.equal(bundle.containsSpendMaterial, false);
  assert.equal(bundle.authenticationVerified, false); assert.equal(bundle.refundExecutable, false);
  assert.equal(bundle.simulationOnly, true); assert.equal(bundle.qualified, false); assert.deepEqual(bundle.executableOperations, []);
  assert.ok(Object.isFrozen(bundle.envelope.events)); assert.equal(statSync(f.file).mode & 0o777, 0o600);
});
test('idempotent replay survives reopen, changed event conflicts and stale new append fails CAS', t => {
  const f = setup(t), e = event('event-0001'); const first = appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: e});
  const replay = appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: structuredClone(e)});
  assert.equal(replay.appended, false); assert.equal(replay.duplicate, true); assert.deepEqual(replay.checkpoint, first.checkpoint);
  assert.throws(() => appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: {...e, payload: {termsDigest: 'b'.repeat(64)}}}), /conflicting event replay/);
  assert.throws(() => appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: event('event-0002')}), /compare-and-swap/);
});
test('valid-line truncation and rewritten hashes are detected against independent checkpoint', t => {
  const f = setup(t); const first = appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: event('event-0001')});
  const record = JSON.parse(readFileSync(f.file, 'utf8')); record.event.payload.termsDigest = 'b'.repeat(64);
  const {recordHash, ...body} = record; record.recordHash = dataHash(body); writeFileSync(f.file, JSON.stringify(canonical(record)) + '\n');
  assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: first.checkpoint}), /trusted checkpoint mismatch/);
  writeFileSync(f.file, ''); assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: first.checkpoint}), /rollback\/truncation/);
});
test('torn tails fail closed on read and append without truncating original evidence', t => {
  const f = setup(t); const first = appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: event('event-0001')});
  appendFileSync(f.file, '{"schemaVersion":1'); const before = readFileSync(f.file);
  assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: first.checkpoint}), /torn journal tail/);
  assert.throws(() => appendOfflineJournal({...f, expectedCheckpoint: first.checkpoint, event: event('event-0002')}), /torn journal tail/);
  assert.deepEqual(readFileSync(f.file), before);
});
test('bad UTF-8, duplicated keys and record mutations are rejected', t => {
  const f = setup(t); const first = appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: event('event-0001')});
  const line = readFileSync(f.file, 'utf8');
  writeFileSync(f.file, Buffer.from([0xff, 0x0a])); assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: first.checkpoint}));
  writeFileSync(f.file, line.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
  assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: first.checkpoint}), /noncanonical/);
  writeFileSync(f.file, line.replace(termsDigest, 'b'.repeat(64)));
  assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: first.checkpoint}), /digest mismatch/);
});
test('existing writer lock prevents stealing after an unclean stop', t => {
  const f = setup(t); writeFileSync(join(f.directory, 'writer.lock'), 'synthetic interrupted writer\n', {mode: 0o600});
  assert.throws(() => appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: event('event-0001')}), /no automatic stale-lock removal/);
  assert.equal(readFileSync(join(f.directory, 'writer.lock'), 'utf8'), 'synthetic interrupted writer\n');
});
test('symlink/hardlink journal files and broad permissions are rejected', t => {
  const f = setup(t); chmodSync(f.file, 0o644);
  assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: f.checkpoint}), /private owned/);
  chmodSync(f.file, 0o600); const alias = join(f.directory, 'hardlink'); linkSync(f.file, alias);
  assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: f.checkpoint}), /single-link/);
  unlinkSync(alias); unlinkSync(f.file); symlinkSync(alias, f.file);
  assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: f.checkpoint})); chmodSync(f.directory, 0o755);
  assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: f.checkpoint}), /private owned nonsymlink/);
});
test('secret-bearing or effect-bearing event payloads cannot enter this journal', t => {
  const f = setup(t); const bad = event('event-0001'); bad.payload.walletPassword = 'synthetic';
  assert.throws(() => appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: bad}), /unexpected/);
  assert.throws(() => appendOfflineJournal({...f, expectedCheckpoint: f.checkpoint, event: {...event('event-0001'), type: 'SEND_TRANSACTION'}}), /no executable intents/);
  assert.throws(() => readOfflineJournal({...f, minimumCheckpoint: emptyOfflineCheckpoint('other-trade:1')}), /invalid checkpoint/);
});
test('a separate process can replay the fsynced journal after the writer exits', t => {
  const f = setup(t); const args = {...f, expectedCheckpoint: f.checkpoint, event: event('event-0001')};
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode(args) + '\nprocess.exit(19);'], {encoding: 'utf8'});
  assert.equal(child.status, 19, child.stderr); const output = JSON.parse(child.stdout);
  assert.deepEqual(readOfflineJournal({...f, minimumCheckpoint: output.checkpoint}).events, [event('event-0001')]);
});
test('two real child writers cannot append distinct events with the same expected head', async t => {
  const f = setup(t);
  const run = id => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode({...f, expectedCheckpoint: f.checkpoint, event: event(id)})], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
    child.once('error', reject); child.once('exit', code => resolveResult({code, out, err}));
  });
  const results = await Promise.all([run('event-0001'), run('event-0002')]);
  assert.equal(results.filter(r => r.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter(r => r.code === 12).length, 1, JSON.stringify(results));
  assert.equal(readOfflineJournal({...f, minimumCheckpoint: f.checkpoint}).events.length, 1);
});
