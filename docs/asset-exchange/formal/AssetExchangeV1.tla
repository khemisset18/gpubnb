---- MODULE AssetExchangeV1 ----
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Maker, Taker1, Taker2, MaxEpoch, DeploymentA, DeploymentB

Actors == {Maker, Taker1, Taker2}
Deployments == {DeploymentA, DeploymentB}
CurrentDeployment == DeploymentA

OfferStates == {"OPEN", "RESERVED", "CANCELLED", "CONSUMED"}
TradeStates == {"NONE", "TERMS_SIGNED", "A_LOCKED", "B_LOCKED",
                "SECRET_REVEALED", "COUNTER_REDEEM_CONFIRMED", "COMPLETED",
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
  replayConsumed,
  lockCreatedEpoch,
  offerDeployment,
  refundMatured,
  exchangeAvailable

vars == <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
          bundleGenerated, bundleValidated, bundleExported, policyEpoch,
          commandEpoch, mode, targetMode, chainA, chainB, feeState, kycStatus,
          recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed,
          lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

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
  /\ lockCreatedEpoch = 0
  /\ offerDeployment \in Deployments
  /\ refundMatured = FALSE
  /\ exchangeAvailable = TRUE

CanAccept(t) ==
  /\ t \in {Taker1, Taker2}
  /\ offerState = "OPEN"
  /\ offerDeployment = CurrentDeployment
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
                  coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

Cancel ==
  /\ offerState = "OPEN"
  /\ offerState' = "CANCELLED"
  /\ UNCHANGED <<acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported,
                  policyEpoch, commandEpoch, mode, targetMode, chainA, chainB,
                  feeState, kycStatus, recoveryEnabled, newLocksEnabled,
                  coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

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
                  newLocksEnabled, coreAvailable, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

GenerateBundle ==
  /\ termsSigned
  /\ bundleGenerated' = TRUE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleValidated, bundleExported, policyEpoch, commandEpoch,
                  mode, targetMode, chainA, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

ValidateBundle ==
  /\ bundleGenerated
  /\ bundleValidated' = TRUE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleExported, policyEpoch, commandEpoch,
                  mode, targetMode, chainA, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

ExportBundle ==
  /\ bundleValidated
  /\ bundleExported' = TRUE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, policyEpoch, commandEpoch,
                  mode, targetMode, chainA, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

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
  /\ lockCreatedEpoch' = policyEpoch
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, bundleGenerated,
                  bundleValidated, bundleExported, policyEpoch, commandEpoch,
                  mode, targetMode, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed,
                  offerDeployment, refundMatured, exchangeAvailable>>

ConfirmA ==
  /\ tradeState = "A_LOCKED"
  /\ chainA = "MEMPOOL"
  /\ chainA' = "CONFIRMED"
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

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
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

ConfirmB ==
  /\ tradeState = "B_LOCKED"
  /\ chainB = "MEMPOOL"
  /\ chainB' = "CONFIRMED"
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

RevealSecret ==
  /\ chainA = "CONFIRMED"
  /\ chainB = "CONFIRMED"
  /\ tradeState = "B_LOCKED"
  /\ chainB' = "SPENT_REDEEM"
  /\ tradeState' = "SECRET_REVEALED"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

ConfirmCounterRedeem ==
  /\ tradeState = "SECRET_REVEALED"
  /\ chainB = "SPENT_REDEEM"
  /\ chainA = "CONFIRMED"
  /\ chainA' = "SPENT_REDEEM"
  /\ tradeState' = "COUNTER_REDEEM_CONFIRMED"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

Complete ==
  /\ chainA = "SPENT_REDEEM"
  /\ chainB = "SPENT_REDEEM"
  /\ tradeState = "COUNTER_REDEEM_CONFIRMED"
  /\ tradeState' = "COMPLETED"
  /\ feeState' = "CLAIMABLE"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

BecomeRefundEligible ==
  /\ tradeState \in {"A_LOCKED", "B_LOCKED", "REORG_HOLD"}
  /\ refundMatured
  /\ recoveryEnabled
  /\ tradeState' = "REFUND_ELIGIBLE"
  /\ feeState' = "REFUNDABLE"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

Refund ==
  /\ tradeState = "REFUND_ELIGIBLE"
  /\ recoveryEnabled
  /\ tradeState' = "REFUNDED"
  /\ feeState' = "REFUNDED"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

ReorgA ==
  /\ chainA \in {"CONFIRMED", "SPENT_REDEEM"}
  /\ chainA' = "REORGED"
  /\ tradeState' = "REORG_HOLD"
  /\ UNCHANGED <<offerState, acceptedBy, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainB, feeState, kycStatus,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

BeginModeTransition(newMode) ==
  /\ newMode \in {"CONFORMITE", "SOUVERAIN"}
  /\ newMode # mode
  /\ mode # "TRANSITION"
  /\ policyEpoch < MaxEpoch
  /\ targetMode' = newMode
  /\ mode' = "TRANSITION"
  /\ policyEpoch' = policyEpoch + 1
  /\ newLocksEnabled' = FALSE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, commandEpoch,
                  chainA, chainB, feeState, kycStatus, recoveryEnabled,
                  coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

ActivateTargetMode ==
  /\ mode = "TRANSITION"
  /\ mode' = targetMode
  /\ newLocksEnabled' = TRUE
  /\ commandEpoch' = policyEpoch
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  targetMode, chainA, chainB, feeState, kycStatus,
                  recoveryEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

ChangeKycStatus(s) ==
  /\ s \in KycStates
  /\ kycStatus' = s
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, feeState,
                  recoveryEnabled, newLocksEnabled, coreAvailable, replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured, exchangeAvailable>>

AssetExchangeOutage ==
  /\ exchangeAvailable
  /\ exchangeAvailable' = FALSE
  /\ coreAvailable' = TRUE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, feeState,
                  kycStatus, recoveryEnabled, newLocksEnabled, replayConsumed,
                  lockCreatedEpoch, offerDeployment, refundMatured>>

AssetExchangeRestart ==
  /\ ~exchangeAvailable
  /\ exchangeAvailable' = TRUE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, feeState,
                  kycStatus, recoveryEnabled, newLocksEnabled, coreAvailable,
                  replayConsumed, lockCreatedEpoch, offerDeployment, refundMatured>>

AdvanceRefundTime ==
  /\ ~refundMatured
  /\ refundMatured' = TRUE
  /\ UNCHANGED <<offerState, acceptedBy, tradeState, termsSigned, lockBroadcast,
                  bundleGenerated, bundleValidated, bundleExported, policyEpoch,
                  commandEpoch, mode, targetMode, chainA, chainB, feeState,
                  kycStatus, recoveryEnabled, newLocksEnabled, coreAvailable,
                  replayConsumed, lockCreatedEpoch, offerDeployment, exchangeAvailable>>

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
  \/ RevealSecret
  \/ ConfirmCounterRedeem
  \/ Complete
  \/ BecomeRefundEligible
  \/ Refund
  \/ ReorgA
  \/ \E m \in {"CONFORMITE", "SOUVERAIN"}: BeginModeTransition(m)
  \/ ActivateTargetMode
  \/ \E s \in KycStates: ChangeKycStatus(s)
  \/ AssetExchangeOutage
  \/ AssetExchangeRestart
  \/ AdvanceRefundTime

TypeOK ==
  /\ offerState \in OfferStates
  /\ acceptedBy \subseteq {Taker1, Taker2}
  /\ tradeState \in TradeStates
  /\ termsSigned \in BOOLEAN
  /\ lockBroadcast \in BOOLEAN
  /\ bundleGenerated \in BOOLEAN
  /\ bundleValidated \in BOOLEAN
  /\ bundleExported \in BOOLEAN
  /\ MaxEpoch \in Nat
  /\ policyEpoch \in 0..MaxEpoch
  /\ commandEpoch \in 0..MaxEpoch
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
  /\ lockCreatedEpoch \in 0..MaxEpoch
  /\ offerDeployment \in Deployments
  /\ refundMatured \in BOOLEAN
  /\ exchangeAvailable \in BOOLEAN

NoDoubleFill == Cardinality(acceptedBy) <= 1

NoUnsignedLock == lockBroadcast => termsSigned

RecoveryBeforeLock ==
  lockBroadcast => (bundleGenerated /\ bundleValidated /\ bundleExported)

EpochFence ==
  lockBroadcast => lockCreatedEpoch <= policyEpoch

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

CompletedRequiresRedeems ==
  tradeState = "COMPLETED" => (chainA = "SPENT_REDEEM" /\ chainB = "SPENT_REDEEM")

CrossDeploymentReplayBlocked ==
  (offerState \in {"RESERVED", "CONSUMED"} \/ lockBroadcast)
    => offerDeployment = CurrentDeployment

\* Scenario-specific liveness models with explicit fairness assumptions.

CooperativeInit ==
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
  /\ mode = "CONFORMITE"
  /\ targetMode = "CONFORMITE"
  /\ chainA = "UNSEEN"
  /\ chainB = "UNSEEN"
  /\ feeState = "PENDING"
  /\ kycStatus = "APPROVED"
  /\ recoveryEnabled = TRUE
  /\ newLocksEnabled = TRUE
  /\ coreAvailable = TRUE
  /\ replayConsumed = FALSE
  /\ lockCreatedEpoch = 0
  /\ offerDeployment = CurrentDeployment
  /\ refundMatured = FALSE
  /\ exchangeAvailable = TRUE

CooperativeNext ==
  \/ Accept(Taker1)
  \/ SignTerms
  \/ GenerateBundle
  \/ ValidateBundle
  \/ ExportBundle
  \/ BroadcastALock
  \/ ConfirmA
  \/ BroadcastBLock
  \/ ConfirmB
  \/ RevealSecret
  \/ ConfirmCounterRedeem
  \/ Complete

CooperativeSpec ==
  /\ CooperativeInit
  /\ [][CooperativeNext]_vars
  /\ WF_vars(Accept(Taker1))
  /\ WF_vars(SignTerms)
  /\ WF_vars(GenerateBundle)
  /\ WF_vars(ValidateBundle)
  /\ WF_vars(ExportBundle)
  /\ WF_vars(BroadcastALock)
  /\ WF_vars(ConfirmA)
  /\ WF_vars(BroadcastBLock)
  /\ WF_vars(ConfirmB)
  /\ WF_vars(RevealSecret)
  /\ WF_vars(ConfirmCounterRedeem)
  /\ WF_vars(Complete)

CooperativeCompletion == <> (tradeState = "COMPLETED")

RecoveryInit ==
  /\ offerState = "CONSUMED"
  /\ acceptedBy = {Taker1}
  /\ tradeState = "A_LOCKED"
  /\ termsSigned = TRUE
  /\ lockBroadcast = TRUE
  /\ bundleGenerated = TRUE
  /\ bundleValidated = TRUE
  /\ bundleExported = TRUE
  /\ policyEpoch = 0
  /\ commandEpoch = 0
  /\ mode = "SOUVERAIN"
  /\ targetMode = "SOUVERAIN"
  /\ chainA = "CONFIRMED"
  /\ chainB = "UNSEEN"
  /\ feeState = "PENDING"
  /\ kycStatus = "UNAVAILABLE"
  /\ recoveryEnabled = TRUE
  /\ newLocksEnabled = FALSE
  /\ coreAvailable = TRUE
  /\ replayConsumed = TRUE
  /\ lockCreatedEpoch = 0
  /\ offerDeployment = CurrentDeployment
  /\ refundMatured = FALSE
  /\ exchangeAvailable = FALSE

RecoveryNext ==
  \/ AdvanceRefundTime
  \/ BecomeRefundEligible
  \/ Refund

RecoverySpec ==
  /\ RecoveryInit
  /\ [][RecoveryNext]_vars
  /\ WF_vars(AdvanceRefundTime)
  /\ WF_vars(BecomeRefundEligible)
  /\ WF_vars(Refund)

RecoveryEventuallyRefunded == <> (tradeState = "REFUNDED")
RecoveryIndependentOfExchange ==
  []((~exchangeAvailable /\ tradeState \in {"A_LOCKED", "REFUND_ELIGIBLE"}) => recoveryEnabled)

TransitionInit ==
  /\ offerState = "OPEN"
  /\ acceptedBy = {}
  /\ tradeState = "NONE"
  /\ termsSigned = FALSE
  /\ lockBroadcast = FALSE
  /\ bundleGenerated = FALSE
  /\ bundleValidated = FALSE
  /\ bundleExported = FALSE
  /\ policyEpoch = 1
  /\ commandEpoch = 0
  /\ mode = "TRANSITION"
  /\ targetMode = "SOUVERAIN"
  /\ chainA = "UNSEEN"
  /\ chainB = "UNSEEN"
  /\ feeState = "PENDING"
  /\ kycStatus = "UNAVAILABLE"
  /\ recoveryEnabled = TRUE
  /\ newLocksEnabled = FALSE
  /\ coreAvailable = TRUE
  /\ replayConsumed = FALSE
  /\ lockCreatedEpoch = 0
  /\ offerDeployment = CurrentDeployment
  /\ refundMatured = FALSE
  /\ exchangeAvailable = TRUE

TransitionNext == ActivateTargetMode

TransitionSpec ==
  /\ TransitionInit
  /\ [][TransitionNext]_vars
  /\ WF_vars(ActivateTargetMode)

TransitionEventuallyActive ==
  <> (mode = targetMode /\ mode # "TRANSITION" /\ newLocksEnabled)

Spec == Init /\ [][Next]_vars

====
