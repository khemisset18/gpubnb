---- MODULE AssetExchangeV1 ----
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Maker, Taker1, Taker2

Actors == {Maker, Taker1, Taker2}

OfferStates == {"OPEN", "RESERVED", "CANCELLED", "CONSUMED"}
TradeStates == {"NONE", "TERMS_SIGNED", "A_LOCKED", "B_LOCKED", "COMPLETED",
                "REFUND_ELIGIBLE", "REFUNDED", "REORG_HOLD"}
Modes == {"CONFORMITE", "SOUVERAIN", "TRANSITION"}
ChainStates == {"UNSEEN", "MEMPOOL", "CONFIRMED", "REORGED", "SPENT_REDEEM", "SPENT_REFUND"}
FeeStates == {"PENDING", "CLAIMABLE", "COLLECTED", "REFUNDABLE", "REFUNDED"}
KycStates == {"NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED", "UNAVAILABLE"}

VARIABLES
  offerState,
  acceptedBy,
  tradeState,
  termsSigned,
  lockBroadcast,
  bundleGenerated,
  bundleValidated,
  bundleExported,
  policyEpoch,
  commandEpoch,
  mode,
  targetMode,
  chainA,
  chainB,
  feeState,
  kycStatus,
  recoveryEnabled,
  newLocksEnabled,
  coreAvailable,
  replayConsumed

vars == <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
          bundleGenerated, bundleValidated, bundleExported, policyEpoch,
          commandEpoch, mode, targetMode, chainA, chainB, feeState, kycStatus,
          recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

Init ==
  /\ offerState = "OPEN"
  /\ acceptedBy = {}
  /\ tradeState = "NONE"
  /\ termsSigned = FALSE
  /\ lockBroadcast = FALSE
  /\ bundleGenerated = FALSE
  /\ bundleValidated = FALSE
  /\ bundleExported = FALSE
  /\ policyEpoch = 0
  /\ commandEpoch = 0
  /\ mode \in {"CONFORMITE", "SOUVERAIN"}
  /\ targetMode = mode
  /\ chainA = "UNSEEN"
  /\ chainB = "UNSEEN"
  /\ feeState = "PENDING"
  /\ kycStatus \in KycStates
  /\ recoveryEnabled = TRUE
  /\ newLocksEnabled = TRUE
  /\ coreAvailable = TRUE
  /\ replayConsumed = FALSE

CanAccept(t) ==
  /\ t \in {Taker1, Taker2}
  /\ offerState = "OPEN"
  /\ IF mode = "CONFORMITE" THEN kycStatus = "APPROVED" ELSE kycStatus \in KycStates
  /\ mode # "TRANSITION"

Accept(t) ==
  /\ CanAccept(t)
  /\ offerState' = "RESERVED"
  /\ acceptedBy' = {t}
  /\ UNCHANGED <<tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported,
                  policyEpoch, commandEpoch, mode, targetMode, chainA, chainB,
                  feeState, kycStatus, recoveryEnabled, newLocksEnabled,
                  coreAvailable, replayConsumed>>

Cancel ==
  /\ offerState = "OPEN"
  /\ offerState' = "CANCELLED"
  /\ UNCHANGED <<acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported,
                  policyEpoch, commandEpoch, mode, targetMode, chainA, chainB,
                  feeState, kycStatus, recoveryEnabled, newLocksEnabled,
                  coreAvailable, replayConsumed>>

SignTerms ==
  /\ offerState = "RESERVED"
  /\ Cardinality(acceptedBy) = 1
  /\ termsSigned' = TRUE
  /\ tradeState' = "TERMS_SIGNED"
  /\ offerState' = "CONSUMED"
  /\ replayConsumed' = TRUE
  /\ UNCHANGED <<acceptedBy, lockBroadcast, bundleGenerated, bundleValidated,
                  bundleExported, policyEpoch, commandEpoch, mode, targetMode,
                  chainA, chainB, feeState, kycStatus, recoveryEnabled,
                  newLocksEnabled, coreAvailable>>

GenerateBundle ==
  /\ termsSigned
  /\ bundleGenerated' = TRUE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleValidated, bundleExported, policyEpoch, commandEpoch,
                  mode, targetMode, chainA, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

ValidateBundle ==
  /\ bundleGenerated
  /\ bundleValidated' = TRUE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleExported, policyEpoch, commandEpoch,
                  mode, targetMode, chainA, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

ExportBundle ==
  /\ bundleValidated
  /\ bundleExported' = TRUE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, policyEpoch, commandEpoch,
                  mode, targetMode, chainA, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

BroadcastALock ==
  /\ termsSigned
  /\ bundleGenerated
  /\ bundleValidated
  /\ bundleExported
  /\ newLocksEnabled
  /\ commandEpoch = policyEpoch
  /\ tradeState = "TERMS_SIGNED"
  /\ lockBroadcast' = TRUE
  /\ tradeState' = "A_LOCKED"
  /\ chainA' = "MEMPOOL"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, bundleGenerated,
                  bundleValidated, bundleExported, policyEpoch, commandEpoch,
                  mode, targetMode, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

ConfirmA ==
  /\ tradeState = "A_LOCKED"
  /\ chainA = "MEMPOOL"
  /\ chainA' = "CONFIRMED"
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

BroadcastBLock ==
  /\ chainA = "CONFIRMED"
  /\ tradeState = "A_LOCKED"
  /\ newLocksEnabled
  /\ commandEpoch = policyEpoch
  /\ tradeState' = "B_LOCKED"
  /\ chainB' = "MEMPOOL"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

ConfirmB ==
  /\ tradeState = "B_LOCKED"
  /\ chainB = "MEMPOOL"
  /\ chainB' = "CONFIRMED"
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

Complete ==
  /\ chainA = "CONFIRMED"
  /\ chainB = "CONFIRMED"
  /\ tradeState = "B_LOCKED"
  /\ tradeState' = "COMPLETED"
  /\ feeState' = "CLAIMABLE"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

BecomeRefundEligible ==
  /\ tradeState \in {"A_LOCKED", "B_LOCKED", "REORG_HOLD"}
  /\ recoveryEnabled
  /\ tradeState' = "REFUND_ELIGIBLE"
  /\ feeState' = "REFUNDABLE"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

Refund ==
  /\ tradeState = "REFUND_ELIGIBLE"
  /\ recoveryEnabled
  /\ tradeState' = "REFUNDED"
  /\ feeState' = "REFUNDED"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

ReorgA ==
  /\ chainA = "CONFIRMED"
  /\ chainA' = "REORGED"
  /\ tradeState' = "REORG_HOLD"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

BeginModeTransition(newMode) ==
  /\ newMode \in {"CONFORMITE", "SOUVERAIN"}
  /\ newMode # mode
  /\ mode # "TRANSITION"
  /\ targetMode' = newMode
  /\ mode' = "TRANSITION"
  /\ policyEpoch' = policyEpoch + 1
  /\ newLocksEnabled' = FALSE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, commandEpoch,
                  chainA, chainB, feeState, kycStatus, recoveryEnabled,
                  coreAvailable, replayConsumed>>

ActivateTargetMode ==
  /\ mode = "TRANSITION"
  /\ mode' = targetMode
  /\ newLocksEnabled' = TRUE
  /\ commandEpoch' = policyEpoch
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  targetMode, chainA, chainB, feeState, kycStatus,
                  recoveryEnabled, coreAvailable, replayConsumed>>

ChangeKycStatus(s) ==
  /\ s \in KycStates
  /\ kycStatus' = s
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, feeState,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed>>

AssetExchangeOutage ==
  /\ coreAvailable' = TRUE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, feeState,
                  kycStatus, recoveryEnabled, newLocksEnabled, replayConsumed>>

Next ==
  \/ \E t \in {Taker1, Taker2}: Accept(t)
  \/ Cancel
  \/ SignTerms
  \/ GenerateBundle
  \/ ValidateBundle
  \/ ExportBundle
  \/ BroadcastALock
  \/ ConfirmA
  \/ BroadcastBLock
  \/ ConfirmB
  \/ Complete
  \/ BecomeRefundEligible
  \/ Refund
  \/ ReorgA
  \/ \E m \in {"CONFORMITE", "SOUVERAIN"}: BeginModeTransition(m)
  \/ ActivateTargetMode
  \/ \E s \in KycStates: ChangeKycStatus(s)
  \/ AssetExchangeOutage

TypeOK ==
  /\ offerState \in OfferStates
  /\ acceptedBy \subseteq {Taker1, Taker2}
  /\ tradeState \in TradeStates
  /\ termsSigned \in BOOLEAN
  /\ lockBroadcast \in BOOLEAN
  /\ bundleGenerated \in BOOLEAN
  /\ bundleValidated \in BOOLEAN
  /\ bundleExported \in BOOLEAN
  /\ policyEpoch \in Nat
  /\ commandEpoch \in Nat
  /\ mode \in Modes
  /\ targetMode \in {"CONFORMITE", "SOUVERAIN"}
  /\ chainA \in ChainStates
  /\ chainB \in ChainStates
  /\ feeState \in FeeStates
  /\ kycStatus \in KycStates
  /\ recoveryEnabled \in BOOLEAN
  /\ newLocksEnabled \in BOOLEAN
  /\ coreAvailable \in BOOLEAN
  /\ replayConsumed \in BOOLEAN

NoDoubleFill == Cardinality(acceptedBy) <= 1

NoUnsignedLock == lockBroadcast => termsSigned

RecoveryBeforeLock ==
  lockBroadcast => (bundleGenerated /\ bundleValidated /\ bundleExported)

EpochFence ==
  (tradeState \in {"A_LOCKED", "B_LOCKED"}) => commandEpoch = policyEpoch

RecoveryNeverDisabled == recoveryEnabled

CoreIndependent == coreAvailable

CompletedNotRefunded ==
  tradeState = "COMPLETED" => tradeState # "REFUNDED"

RefundedNotCompleted ==
  tradeState = "REFUNDED" => tradeState # "COMPLETED"

KycCannotDisableRecovery ==
  kycStatus \in KycStates => recoveryEnabled

FeeDoesNotGateRecovery ==
  tradeState = "REFUND_ELIGIBLE" => recoveryEnabled

Spec == Init /\ [][Next]_vars

====
