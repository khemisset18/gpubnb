import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Stage4VideoContinuity } from '../../web/windows-native-continuity.js';

const frame = (sequence: number, epoch = 1n) => ({
  state: 'ready',
  streamEpoch: epoch,
  frameSequence: BigInt(sequence),
  renderedFrames: sequence,
});

test('300 seconds only pass after actual advancing decoded-frame observations', () => {
  const proof = new Stage4VideoContinuity();
  for (let second = 0; second <= 300; second += 1) {
    const state = proof.observe(frame(second + 1), second * 1000);
    if (second < 300) assert.equal(state.video300sObserved, false);
  }
  const state = proof.snapshot(300_000);
  assert.equal(state.video300sObserved, true);
  assert.equal(state.continuousSeconds, 300);
  assert.ok(state.renderedFrames >= 301);
  assert.equal(state.inputEffectVerified, false, 'video does not prove keyboard or mouse effect');
});

test('one stalled frame and a clock jump cannot produce a 300 second pass', () => {
  const proof = new Stage4VideoContinuity();
  proof.observe(frame(1), 0);
  assert.equal(proof.snapshot(300_000).video300sObserved, false);
  assert.equal(proof.snapshot(300_000).continuousSeconds, 0);
  assert.ok(proof.snapshot(300_000).interruptions >= 1);
  proof.observe(frame(2), 300_001);
  proof.observe(frame(3), 300_002);
  assert.equal(proof.snapshot(300_002).video300sObserved, false);
});

test('disconnect, stream epoch change and replayed sequence all restart the proof', () => {
  const proof = new Stage4VideoContinuity();
  proof.observe(frame(1), 0);
  proof.observe(frame(2), 1000);
  proof.observe(frame(3, 2n), 2000);
  assert.equal(proof.snapshot(2000).continuousSeconds, 0);
  proof.observe(frame(4, 2n), 3000);
  proof.observe(frame(4, 2n), 4000);
  assert.equal(proof.snapshot(4000).continuousSeconds, 0);
  proof.observe(frame(5, 2n), 5000);
  proof.reset();
  assert.equal(proof.snapshot(6000).continuousSeconds, 0);
  assert.ok(proof.snapshot(6000).interruptions >= 3);
  assert.equal(proof.snapshot(6000).inputEffectVerified, false);
});

test('browser page shows a video-only monitor, while manual input proof remains separate', () => {
  const html = readFileSync(new URL('../../web/windows-native-desktop.html', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../../web/windows-native-desktop-page.js', import.meta.url), 'utf8');
  assert.match(html, /id="nativeDesktopContinuity"/);
  assert.match(page, /proof\.observe\(state, proofNow\(\)\)/);
  assert.match(page, /resetProof\(\)/);
  assert.match(page, /effet des commandes à confirmer/);
  assert.doesNotMatch(page, /inputEffectVerified\s*=\s*true/);
});
