// Local POSIX research journal. Hash chaining detects corruption only when a separate trusted checkpoint is retained.
// No authentication, key storage, network transport, signing request or financial effect exists here.
import {constants, lstatSync, mkdirSync, openSync, closeSync, readSync, writeSync, fsyncSync, fstatSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {exactObject, requireThat, text, digest, dataHash, canonical, offline} from './offline-data.mjs';
const ZERO = '0'.repeat(64), MAX_BYTES = 1024 * 1024, MAX_RECORDS = 4096;
const ID = /^[A-Za-z0-9:-]{8,128}$/;
function privateDirectory(directory, create = false) {
  requireThat(process.platform !== 'win32', 'journal requires POSIX file semantics; Windows NOT TESTED');
  if (create) {
    try { mkdirSync(directory, {mode: 0o700}); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const st = lstatSync(directory);
  requireThat(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && st.uid === process.getuid(), 'private owned nonsymlink journal directory required');
}
function syncDirectory(directory) { const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function regular(fd) {
  const st = fstatSync(fd);
  requireThat(st.isFile() && st.nlink === 1 && (st.mode & 0o077) === 0 && st.uid === process.getuid(), 'private owned single-link regular journal required');
  requireThat(st.size <= MAX_BYTES, 'journal byte bound exceeded');
}
function eventShape(event, tradeId) {
  exactObject(event, ['schemaVersion', 'id', 'tradeId', 'type', 'payload'], 'journal event');
  requireThat(event.schemaVersion === 1 && event.tradeId === tradeId, 'journal trade/version mismatch');
  text(event.id, ID, 'event id');
  const p = event.payload;
  switch (event.type) {
    case 'TERMS_BOUND': exactObject(p, ['termsDigest'], 'terms event'); digest(p.termsDigest, 'terms'); break;
    case 'OBSERVATION':
      exactObject(p, ['evidenceDigest', 'leg', 'epoch'], 'observation event'); digest(p.evidenceDigest, 'evidence');
      requireThat(['A', 'B'].includes(p.leg) && Number.isSafeInteger(p.epoch) && p.epoch >= 0, 'invalid observation identity'); break;
    case 'REORG':
      exactObject(p, ['leg', 'newEpoch'], 'reorg event'); requireThat(['A', 'B'].includes(p.leg) && Number.isSafeInteger(p.newEpoch) && p.newEpoch > 0, 'invalid reorg identity'); break;
    case 'HOLD': exactObject(p, ['reason'], 'hold event'); text(p.reason, /^[A-Z_]{4,64}$/, 'hold reason'); break;
    case 'RECOVERY_EXPORTED': exactObject(p, ['bundleDigest'], 'recovery event'); digest(p.bundleDigest, 'bundle'); break;
    case 'OFFLINE_PROTOCOL_EVENT': exactObject(p, ['protocolEventDigest'], 'offline protocol event'); digest(p.protocolEventDigest, 'protocol event'); break;
    default: throw new Error('unsupported journal event; no executable intents allowed');
  }
  requireThat(Buffer.byteLength(JSON.stringify(canonical(event))) <= 4096, 'event byte bound exceeded');
}
export function emptyOfflineCheckpoint(tradeId) { text(tradeId, ID, 'trade id'); return {schemaVersion: 1, tradeId, sequence: 0, headHash: ZERO}; }
function checkpointShape(value, tradeId) {
  exactObject(value, ['schemaVersion', 'tradeId', 'sequence', 'headHash'], 'independent checkpoint');
  requireThat(value.schemaVersion === 1 && value.tradeId === tradeId && Number.isSafeInteger(value.sequence) && value.sequence >= 0 && value.sequence <= MAX_RECORDS, 'invalid checkpoint');
  digest(value.headHash, 'checkpoint hash');
}
function decode(bytes, tradeId, minimumCheckpoint) {
  checkpointShape(minimumCheckpoint, tradeId);
  requireThat(bytes.length <= MAX_BYTES, 'journal byte bound exceeded');
  const input = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  requireThat(input === '' || input.endsWith('\n'), 'torn journal tail: explicit recovery required');
  const lines = input === '' ? [] : input.slice(0, -1).split('\n');
  requireThat(lines.length <= MAX_RECORDS, 'journal record bound exceeded');
  let head = ZERO;
  const seen = new Set(), records = [];
  for (const [i, line] of lines.entries()) {
    requireThat(line.length > 0 && Buffer.byteLength(line) <= 8192, 'invalid journal record size');
    const r = JSON.parse(line);
    exactObject(r, ['schemaVersion', 'sequence', 'previousHash', 'event', 'recordHash'], 'record');
    requireThat(r.schemaVersion === 1 && r.sequence === i + 1 && r.previousHash === head, 'journal continuity mismatch');
    eventShape(r.event, tradeId);
    requireThat(!seen.has(r.event.id), 'duplicate persisted event id'); seen.add(r.event.id);
    digest(r.recordHash, 'record hash');
    const {recordHash, ...body} = r;
    requireThat(dataHash(body) === recordHash, 'journal record digest mismatch');
    // Requiring canonical bytes removes ambiguous rewrites, duplicate JSON keys and hidden whitespace.
    requireThat(JSON.stringify(canonical(r)) === line, 'noncanonical journal bytes');
    head = recordHash; records.push(r);
  }
  requireThat(minimumCheckpoint.sequence <= records.length, 'journal rollback/truncation before trusted checkpoint');
  const witnessed = minimumCheckpoint.sequence === 0 ? ZERO : records[minimumCheckpoint.sequence - 1].recordHash;
  requireThat(witnessed === minimumCheckpoint.headHash, 'trusted checkpoint mismatch');
  return {records, checkpoint: {schemaVersion: 1, tradeId, sequence: records.length, headHash: head}};
}
function load(directory, tradeId, minimumCheckpoint) {
  privateDirectory(directory);
  const fd = openSync(join(directory, 'journal.ndjson'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    regular(fd); const buffer = Buffer.alloc(MAX_BYTES + 1); let count = 0;
    while (count < buffer.length) { const n = readSync(fd, buffer, count, buffer.length - count, null); if (n === 0) break; count += n; }
    return decode(buffer.subarray(0, count), tradeId, minimumCheckpoint);
  }
  finally { closeSync(fd); }
}
export function createOfflineJournal(directory, tradeId) {
  const checkpoint = emptyOfflineCheckpoint(tradeId); privateDirectory(directory, true);
  const fd = openSync(join(directory, 'journal.ndjson'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { regular(fd); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(directory); return offline({checkpoint});
}
export function readOfflineJournal({directory, tradeId, minimumCheckpoint}) {
  const {records, checkpoint} = load(directory, tradeId, minimumCheckpoint);
  return offline({checkpoint, events: records.map(r => r.event)});
}
export function appendOfflineJournal({directory, tradeId, expectedCheckpoint, event}) {
  privateDirectory(directory); checkpointShape(expectedCheckpoint, tradeId); eventShape(event, tradeId);
  const lockPath = join(directory, 'writer.lock');
  let lock;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('writer lock exists; no automatic stale-lock removal'); throw e; }
  try {
    writeSync(lock, JSON.stringify({schemaVersion: 1, pid: process.pid}) + '\n'); fsyncSync(lock); syncDirectory(directory);
    const {records, checkpoint} = load(directory, tradeId, expectedCheckpoint);
    const previous = records.find(r => r.event.id === event.id);
    if (previous) {
      requireThat(dataHash(previous.event) === dataHash(event), 'conflicting event replay');
      return offline({checkpoint, appended: false, duplicate: true});
    }
    requireThat(dataHash(checkpoint) === dataHash(expectedCheckpoint), 'compare-and-swap checkpoint mismatch');
    requireThat(records.length < MAX_RECORDS, 'journal record bound exceeded');
    const body = {schemaVersion: 1, sequence: checkpoint.sequence + 1, previousHash: checkpoint.headHash, event: structuredClone(event)};
    const recordHash = dataHash(body), bytes = Buffer.from(JSON.stringify(canonical({...body, recordHash})) + '\n');
    const fd = openSync(join(directory, 'journal.ndjson'), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      regular(fd); requireThat(fstatSync(fd).size + bytes.length <= MAX_BYTES, 'journal byte bound exceeded');
      let done = 0;
      while (done < bytes.length) { const n = writeSync(fd, bytes, done, bytes.length - done); requireThat(n > 0, 'incomplete journal write'); done += n; }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory(directory);
    return offline({checkpoint: {schemaVersion: 1, tradeId, sequence: body.sequence, headHash: recordHash}, appended: true, duplicate: false});
  } finally { closeSync(lock); unlinkSync(lockPath); syncDirectory(directory); }
}
export function exportOfflineRecovery({directory, tradeId, minimumCheckpoint}) {
  const snapshot = readOfflineJournal({directory, tradeId, minimumCheckpoint});
  const envelope = {schemaVersion: 1, tradeId, checkpoint: snapshot.checkpoint, events: snapshot.events};
  return offline({envelope, envelopeDigest: dataHash(envelope), containsSpendMaterial: false,
    authenticationVerified: false, refundExecutable: false});
}
