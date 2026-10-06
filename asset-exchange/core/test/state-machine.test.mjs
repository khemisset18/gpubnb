import test from "node:test";
import assert from "node:assert/strict";
import { createTradeState, transitionTrade, createOpenOfferState, acceptOffer, cancelOffer } from "../src/index.mjs";

test("lock cannot happen before recovery bundle readiness", () => {
  const s = createTradeState({ tradeId: "trade-00000001", policyEpoch: 4 });
  assert.throws(() => transitionTrade(s, { type: "BROADCAST_A_LOCK", policyEpoch: 4 }));
});

test("stale epoch cannot create a new lock", () => {
  let s = createTradeState({ tradeId: "trade-00000001", policyEpoch: 4 });
  s = transitionTrade(s, { type: "MARK_RECOVERY_READY" });
  assert.throws(() => transitionTrade(s, { type: "BROADCAST_A_LOCK", policyEpoch: 3 }));
  s = transitionTrade(s, { type: "BROADCAST_A_LOCK", policyEpoch: 4 });
  assert.equal(s.state, "A_LOCK_BROADCAST");
});

test("refund requires chain timeout evidence", () => {
  let s = createTradeState({ tradeId: "trade-00000001", policyEpoch: 1 });
  s = transitionTrade(s, { type: "MARK_RECOVERY_READY" });
  s = transitionTrade(s, { type: "BROADCAST_A_LOCK", policyEpoch: 1 });
  assert.throws(() => transitionTrade(s, { type: "MARK_REFUND_ELIGIBLE", chainTimeoutSatisfied: false }));
  s = transitionTrade(s, { type: "MARK_REFUND_ELIGIBLE", chainTimeoutSatisfied: true });
  s = transitionTrade(s, { type: "REFUND", principalRecoveryAuthorized: true });
  assert.equal(s.state, "REFUNDED");
});

test("trade cannot complete from lock confirmations alone", () => {
  let s = createTradeState({ tradeId: "trade-00000001", policyEpoch: 1 });
  s = transitionTrade(s, { type: "MARK_RECOVERY_READY" });
  s = transitionTrade(s, { type: "BROADCAST_A_LOCK", policyEpoch: 1 });
  s = transitionTrade(s, { type: "CONFIRM_A_LOCK" });
  s = transitionTrade(s, { type: "BROADCAST_B_LOCK", policyEpoch: 1 });
  s = transitionTrade(s, { type: "CONFIRM_B_LOCK" });
  assert.throws(() => transitionTrade(s, { type: "COMPLETE", bothPrincipalOutputsSpentAsExpected: true }));
  s = transitionTrade(s, { type: "RECORD_SECRET_REVEAL", validatedChainSpend: true });
  s = transitionTrade(s, { type: "CONFIRM_COUNTER_REDEEM", validatedCounterRedeem: true });
  s = transitionTrade(s, { type: "COMPLETE", bothPrincipalOutputsSpentAsExpected: true });
  assert.equal(s.state, "COMPLETED");
});

test("FAIL_SAFE cannot strand already locked funds", () => {
  let s = createTradeState({ tradeId: "trade-00000001", policyEpoch: 2 });
  s = transitionTrade(s, { type: "MARK_RECOVERY_READY" });
  s = transitionTrade(s, { type: "BROADCAST_A_LOCK", policyEpoch: 2 });
  assert.throws(() => transitionTrade(s, { type: "FAIL_SAFE" }));
});

test("accept/cancel race has a single winner in the pure model", () => {
  const open = createOpenOfferState({ offerId: "offer-00000001", expiryUnixMs: 1000, policyEpoch: 9 });
  const consumed = acceptOffer(open, { tradeId: "trade-00000001", nowUnixMs: 100, policyEpoch: 9 });
  assert.equal(consumed.state, "CONSUMED");
  assert.throws(() => cancelOffer(consumed, { nowUnixMs: 101 }));

  const cancelled = cancelOffer(open, { nowUnixMs: 100 });
  assert.equal(cancelled.state, "CANCELLED");
  assert.throws(() => acceptOffer(cancelled, { tradeId: "trade-00000002", nowUnixMs: 101, policyEpoch: 9 }));
});
