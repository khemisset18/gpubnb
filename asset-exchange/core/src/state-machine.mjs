import { invariant } from "./errors.mjs";

export const TradeState = Object.freeze({
  TERMS_SIGNED: "TERMS_SIGNED",
  RECOVERY_READY: "RECOVERY_READY",
  A_LOCK_BROADCAST: "A_LOCK_BROADCAST",
  A_LOCK_CONFIRMED: "A_LOCK_CONFIRMED",
  B_LOCK_BROADCAST: "B_LOCK_BROADCAST",
  B_LOCK_CONFIRMED: "B_LOCK_CONFIRMED",
  SECRET_REVEALED: "SECRET_REVEALED",
  COUNTER_REDEEM_CONFIRMED: "COUNTER_REDEEM_CONFIRMED",
  COMPLETED: "COMPLETED",
  REORG_HOLD: "REORG_HOLD",
  REFUND_ELIGIBLE: "REFUND_ELIGIBLE",
  REFUNDED: "REFUNDED",
  FAILED_SAFE: "FAILED_SAFE"
});

const TERMINAL = new Set([TradeState.COMPLETED, TradeState.REFUNDED, TradeState.FAILED_SAFE]);

export function createTradeState({ tradeId, policyEpoch, termsFinalized }) {
  invariant(typeof tradeId === "string" && tradeId.length >= 8, "TRADE_ID", "invalid tradeId");
  invariant(termsFinalized === true, "TERMS_NOT_FINALIZED", "trade state requires both parties to have finalized identical settlement terms");
  invariant(Number.isSafeInteger(policyEpoch) && policyEpoch >= 0, "TRADE_EPOCH", "invalid policy epoch");
  return Object.freeze({
    tradeId,
    state: TradeState.TERMS_SIGNED,
    policyEpoch,
    recoveryReady: false,
    aLockBroadcast: false,
    bLockBroadcast: false
  });
}

export function transitionTrade(current, command) {
  invariant(current && command, "STATE_INPUT", "state and command required");
  invariant(!TERMINAL.has(current.state), "STATE_TERMINAL", "terminal trade cannot transition");

  const same = (state, patch = {}) => Object.freeze({ ...current, state, ...patch });

  switch (command.type) {
    case "MARK_RECOVERY_READY":
      invariant(current.state === TradeState.TERMS_SIGNED, "STATE_ORDER", "recovery can only be prepared after signed terms");
      return same(TradeState.RECOVERY_READY, { recoveryReady: true });

    case "BROADCAST_A_LOCK":
      invariant(current.state === TradeState.RECOVERY_READY, "STATE_ORDER", "A lock requires recovery readiness");
      invariant(current.recoveryReady, "RECOVERY_REQUIRED", "recovery bundle must be ready before lock");
      invariant(command.policyEpoch === current.policyEpoch, "STALE_EPOCH", "stale policy epoch cannot create a lock");
      return same(TradeState.A_LOCK_BROADCAST, { aLockBroadcast: true });

    case "CONFIRM_A_LOCK":
      invariant(current.state === TradeState.A_LOCK_BROADCAST, "STATE_ORDER", "A confirmation requires A broadcast");
      return same(TradeState.A_LOCK_CONFIRMED);

    case "BROADCAST_B_LOCK":
      invariant(current.state === TradeState.A_LOCK_CONFIRMED, "STATE_ORDER", "B lock requires confirmed A lock");
      invariant(command.policyEpoch === current.policyEpoch, "STALE_EPOCH", "stale policy epoch cannot create a lock");
      return same(TradeState.B_LOCK_BROADCAST, { bLockBroadcast: true });

    case "CONFIRM_B_LOCK":
      invariant(current.state === TradeState.B_LOCK_BROADCAST, "STATE_ORDER", "B confirmation requires B broadcast");
      return same(TradeState.B_LOCK_CONFIRMED);

    case "RECORD_SECRET_REVEAL":
      invariant(current.state === TradeState.B_LOCK_CONFIRMED, "STATE_ORDER", "secret reveal requires both lock confirmations");
      invariant(command.validatedChainSpend === true, "SECRET_EVIDENCE", "secret must come from validated expected chain spend");
      return same(TradeState.SECRET_REVEALED);

    case "CONFIRM_COUNTER_REDEEM":
      invariant(current.state === TradeState.SECRET_REVEALED, "STATE_ORDER", "counter redeem requires validated secret reveal");
      invariant(command.validatedCounterRedeem === true, "REDEEM_EVIDENCE", "counter redeem must be validated on chain");
      return same(TradeState.COUNTER_REDEEM_CONFIRMED);

    case "COMPLETE":
      invariant(current.state === TradeState.COUNTER_REDEEM_CONFIRMED, "STATE_ORDER", "completion requires both principal settlement legs");
      invariant(command.bothPrincipalOutputsSpentAsExpected === true, "CHAIN_EVIDENCE", "completion requires final principal-spend evidence");
      return same(TradeState.COMPLETED);

    case "ENTER_REORG_HOLD":
      invariant(
        [TradeState.A_LOCK_CONFIRMED, TradeState.B_LOCK_BROADCAST, TradeState.B_LOCK_CONFIRMED, TradeState.SECRET_REVEALED, TradeState.COUNTER_REDEEM_CONFIRMED].includes(current.state),
        "STATE_ORDER",
        "reorg hold not valid from current state"
      );
      return same(TradeState.REORG_HOLD);

    case "MARK_REFUND_ELIGIBLE":
      invariant(
        [TradeState.A_LOCK_BROADCAST, TradeState.A_LOCK_CONFIRMED, TradeState.B_LOCK_BROADCAST, TradeState.B_LOCK_CONFIRMED, TradeState.REORG_HOLD].includes(current.state),
        "STATE_ORDER",
        "refund eligibility not valid from current state"
      );
      invariant(command.chainTimeoutSatisfied === true, "REFUND_TIMEOUT", "refund must be chain-eligible, not wall-clock-only");
      return same(TradeState.REFUND_ELIGIBLE);

    case "REFUND":
      invariant(current.state === TradeState.REFUND_ELIGIBLE, "STATE_ORDER", "refund requires eligibility");
      invariant(command.principalRecoveryAuthorized === true, "REFUND_AUTH", "principal recovery authorization required");
      return same(TradeState.REFUNDED);

    case "FAIL_SAFE":
      invariant(
        [TradeState.TERMS_SIGNED, TradeState.RECOVERY_READY].includes(current.state),
        "FAIL_SAFE_AFTER_LOCK",
        "locked funds must remain in recovery-capable states"
      );
      return same(TradeState.FAILED_SAFE);

    default:
      throw new Error(`unknown trade command: ${String(command.type)}`);
  }
}
