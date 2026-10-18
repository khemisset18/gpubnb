'use strict';

// Browser-side measurement only. This does not prove that remote input had
// an effect, nor does it replace server/PC1 physical-session evidence.
export class Stage4VideoContinuity {
  constructor({ minimumMs = 300_000, maxFrameGapMs = 3_000 } = {}) {
    if (!Number.isSafeInteger(minimumMs) || minimumMs < 1 ||
        !Number.isSafeInteger(maxFrameGapMs) || maxFrameGapMs < 1) {
      throw new Error('stage4_video_proof_config_invalid');
    }
    this.minimumMs = minimumMs;
    this.maxFrameGapMs = maxFrameGapMs;
    this.interruptions = 0;
    this.passed = false;
    this.startedAt = null;
    this.lastAt = null;
    this.epoch = null;
    this.sequence = null;
    this.frames = 0;
  }

  reset() {
    if (this.startedAt !== null) this.interruptions += 1;
    this.passed = false;
    this.startedAt = null;
    this.lastAt = null;
    this.epoch = null;
    this.sequence = null;
    this.frames = 0;
  }

  observe(state, nowMs) {
    if (!Number.isFinite(nowMs) || nowMs < 0 ||
        state?.state !== 'ready' ||
        typeof state.streamEpoch !== 'bigint' || state.streamEpoch <= 0n ||
        typeof state.frameSequence !== 'bigint' || state.frameSequence <= 0n ||
        !Number.isSafeInteger(state.renderedFrames) || state.renderedFrames <= 0) {
      this.reset();
      return this.snapshot(nowMs);
    }
    if (this.startedAt !== null && (
      nowMs < this.lastAt ||
      nowMs - this.lastAt > this.maxFrameGapMs ||
      state.streamEpoch !== this.epoch ||
      state.frameSequence <= this.sequence ||
      state.renderedFrames <= this.frames
    )) this.reset();

    if (this.startedAt === null) this.startedAt = nowMs;
    this.lastAt = nowMs;
    this.epoch = state.streamEpoch;
    this.sequence = state.frameSequence;
    this.frames = state.renderedFrames;
    return this.snapshot(nowMs);
  }

  snapshot(nowMs) {
    if (this.startedAt !== null &&
        (!Number.isFinite(nowMs) || nowMs < this.lastAt ||
         nowMs - this.lastAt > this.maxFrameGapMs)) this.reset();
    // Only the last actual decoded/rendered frame advances the evidence clock.
    // A UI timer must never turn a stalled stream at 299 s into a 300 s pass.
    const elapsedMs = this.startedAt === null ? 0
      : Math.max(0, Math.min(this.lastAt - this.startedAt, this.minimumMs));
    this.passed = this.frames >= 2 && elapsedMs >= this.minimumMs;
    return Object.freeze({
      video300sObserved: this.passed,
      continuousSeconds: Math.floor(elapsedMs / 1000),
      renderedFrames: this.frames,
      interruptions: this.interruptions,
      inputEffectVerified: false, // Must be confirmed physically by operator.
    });
  }
}
