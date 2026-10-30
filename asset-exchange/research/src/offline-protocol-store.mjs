// POSIX durable replay adapter for PUBLIC OFFLINE events. No network, wallet, signer or financial effects.
// Hashes detect rollback only relative to a checkpoint retained independently of this directory.
import {constants, lstatSync, fstatSync, mkdirSync, openSync, readSync, writeSync, closeSync, fsyncSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {canonical, dataHash, requireThat, offline} from './offline-data.mjs';
import {createOfflineJournal, appendOfflineJournal, readOfflineJournal} from './offline-journal.mjs';
import {validateOfflineProtocolConfig, replayOfflineProtocol} from './offline-protocol.mjs';

const MAX_BYTES = 32768, CONFIG_ID = 'protocol:config';
function privateDirectory(path, create = false) {
  requireThat(process.platform !== 'win32', 'offline protocol store requires POSIX; Windows NOT TESTED');
  if (create) mkdirSync(path, {mode: 0o700});
  const stat = lstatSync(path);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'private owned nonsymlink protocol directory required');
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privateFile(fd) {
  const stat = fstatSync(fd);
  requireThat(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && stat.size <= MAX_BYTES,
    'private bounded owned single-link protocol file required');
}
function bytesOf(value) {
  const bytes = Buffer.from(JSON.stringify(canonical(value)) + '\n');
  requireThat(bytes.length <= MAX_BYTES, 'protocol file exceeds byte bound'); return bytes;
}
function readData(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    privateFile(fd); const buffer = Buffer.alloc(MAX_BYTES + 1); let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, null); if (!n) break; count += n;
    }
    requireThat(count <= MAX_BYTES, 'protocol file exceeds byte bound');
    const raw = new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, count)), data = JSON.parse(raw);
    requireThat(raw === bytesOf(data).toString('utf8'), 'noncanonical/torn protocol file'); return data;
  } finally { closeSync(fd); }
}
function writeNew(path, value) {
  const bytes = bytesOf(value), fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    privateFile(fd); let done = 0;
    while (done < bytes.length) { const n = writeSync(fd, bytes, done, bytes.length - done); requireThat(n > 0, 'incomplete protocol write'); done += n; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function archive(directory, event) {
  const hash = dataHash(event), path = join(directory, 'events', hash + '.json');
  try { writeNew(path, event); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    requireThat(dataHash(readData(path)) === hash, 'existing event archive mismatch; explicit recovery required');
  }
  syncDirectory(join(directory, 'events')); return hash;
}
function result(snapshot, config, events) {
  const state = replayOfflineProtocol(config, events);
  return offline({config, events, state, checkpoint: snapshot.checkpoint, modelStateDigest: dataHash(state),
    authenticationVerified: false, realRecoveryVerified: false});
}
export function createOfflineProtocolStore(directory, config) {
  validateOfflineProtocolConfig(config);
  const created = createOfflineJournal(directory, config.tradeId);
  privateDirectory(join(directory, 'events'), true);
  writeNew(join(directory, 'config.json'), config); syncDirectory(directory);
  const bound = appendOfflineJournal({directory, tradeId: config.tradeId, expectedCheckpoint: created.checkpoint,
    event: {schemaVersion: 1, id: CONFIG_ID, tradeId: config.tradeId, type: 'TERMS_BOUND', payload: {termsDigest: dataHash(config)}}});
  return result(bound, structuredClone(config), []);
}
export function readOfflineProtocolStore({directory, tradeId, minimumCheckpoint}) {
  privateDirectory(directory); privateDirectory(join(directory, 'events'));
  // An empty checkpoint could silently adopt a rewritten config plus journal. Never accept it here.
  requireThat(minimumCheckpoint?.sequence >= 1, 'independent nonempty protocol checkpoint required');
  const snapshot = readOfflineJournal({directory, tradeId, minimumCheckpoint}), config = readData(join(directory, 'config.json'));
  validateOfflineProtocolConfig(config); requireThat(config.tradeId === tradeId, 'store trade mismatch');
  const first = snapshot.events[0];
  requireThat(first?.type === 'TERMS_BOUND' && first.id === CONFIG_ID && first.payload.termsDigest === dataHash(config), 'configuration not bound to retained journal checkpoint');
  requireThat(snapshot.events.length <= 49, 'protocol journal event bound exceeded');
  const events = snapshot.events.slice(1).map(entry => {
    requireThat(entry.type === 'OFFLINE_PROTOCOL_EVENT' && entry.id !== CONFIG_ID, 'unsupported protocol journal entry');
    const event = readData(join(directory, 'events', entry.payload.protocolEventDigest + '.json'));
    requireThat(dataHash(event) === entry.payload.protocolEventDigest && event.id === entry.id, 'protocol event archive digest/id mismatch');
    return event;
  });
  return result(snapshot, config, events);
}
function appendLocked({directory, tradeId, expectedCheckpoint, event}) {
  const before = readOfflineProtocolStore({directory, tradeId, minimumCheckpoint: expectedCheckpoint});
  requireThat(event.id !== CONFIG_ID, 'reserved configuration event id');
  const previous = before.events.find(e => e.id === event.id);
  if (previous) {
    requireThat(dataHash(previous) === dataHash(event), 'conflicting protocol event replay');
    return offline({...before, appended: false, duplicate: true});
  }
  requireThat(dataHash(before.checkpoint) === dataHash(expectedCheckpoint), 'compare-and-swap checkpoint mismatch');
  // Validates/replays first. Persisting the event blob before the CAS leaves only harmless orphans if CAS loses.
  // A partial blob or a stale writer lock is deliberately not repaired/removed automatically.
  replayOfflineProtocol(before.config, [...before.events, event]);
  const protocolEventDigest = archive(directory, event);
  const written = appendOfflineJournal({directory, tradeId, expectedCheckpoint,
    event: {schemaVersion: 1, id: event.id, tradeId, type: 'OFFLINE_PROTOCOL_EVENT', payload: {protocolEventDigest}}});
  const after = readOfflineProtocolStore({directory, tradeId, minimumCheckpoint: written.checkpoint});
  return offline({...after, appended: written.appended, duplicate: written.duplicate});
}
export function appendOfflineProtocolEvent(args) {
  const {directory} = args; privateDirectory(directory);
  // Serialize validation + archive + journal commit, not only the final journal append.
  // Stale requests therefore cannot fill disk with unique orphan archives.
  const path = join(directory, 'protocol-writer.lock'); let fd;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('protocol writer lock exists; explicit recovery required'); throw error; }
  try {
    privateFile(fd); writeSync(fd, JSON.stringify({schemaVersion: 1, pid: process.pid}) + '\n'); fsyncSync(fd); syncDirectory(directory);
    return appendLocked(args);
  } finally { closeSync(fd); unlinkSync(path); syncDirectory(directory); }
}
