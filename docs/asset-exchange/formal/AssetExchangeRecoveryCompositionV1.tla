---- MODULE AssetExchangeRecoveryCompositionV1 ----
EXTENDS TLC

Modes == {"CONFORMITE", "SOUVERAIN", "TRANSITION"}
PrincipalStates == {"LOCKED", "REFUND_BROADCAST", "REFUNDED"}

VARIABLES
  refundMatured,
  recoveryBundle,
  userHasKey,
  recoveryEnabled,
  exchangeAvailable,
  feeCollectorAvailable,
  kycAvailable,
  mode,
  newLocksEnabled,
  principalState

vars == <<refundMatured, recoveryBundle, userHasKey, recoveryEnabled,
          exchangeAvailable, feeCollectorAvailable, kycAvailable, mode,
          newLocksEnabled, principalState>>

Init ==
  /\ refundMatured = FALSE
  /\ recoveryBundle = TRUE
  /\ userHasKey = TRUE
  /\ recoveryEnabled = TRUE
  /\ exchangeAvailable = TRUE
  /\ feeCollectorAvailable = TRUE
  /\ kycAvailable = TRUE
  /\ mode \in {"CONFORMITE", "SOUVERAIN"}
  /\ newLocksEnabled = TRUE
  /\ principalState = "LOCKED"

ExchangeOutage ==
  /\ exchangeAvailable
  /\ exchangeAvailable' = FALSE
  /\ UNCHANGED <<refundMatured, recoveryBundle, userHasKey, recoveryEnabled,
                  feeCollectorAvailable, kycAvailable, mode, newLocksEnabled,
                  principalState>>

FeeCollectorOutage ==
  /\ feeCollectorAvailable
  /\ feeCollectorAvailable' = FALSE
  /\ UNCHANGED <<refundMatured, recoveryBundle, userHasKey, recoveryEnabled,
                  exchangeAvailable, kycAvailable, mode, newLocksEnabled,
                  principalState>>

KycOutage ==
  /\ kycAvailable
  /\ kycAvailable' = FALSE
  /\ UNCHANGED <<refundMatured, recoveryBundle, userHasKey, recoveryEnabled,
                  exchangeAvailable, feeCollectorAvailable, mode,
                  newLocksEnabled, principalState>>

BeginTransition ==
  /\ mode # "TRANSITION"
  /\ mode' = "TRANSITION"
  /\ newLocksEnabled' = FALSE
  /\ UNCHANGED <<refundMatured, recoveryBundle, userHasKey, recoveryEnabled,
                  exchangeAvailable, feeCollectorAvailable, kycAvailable,
                  principalState>>

AdvanceRefundTime ==
  /\ ~refundMatured
  /\ refundMatured' = TRUE
  /\ UNCHANGED <<recoveryBundle, userHasKey, recoveryEnabled,
                  exchangeAvailable, feeCollectorAvailable, kycAvailable,
                  mode, newLocksEnabled, principalState>>

BroadcastRefund ==
  /\ principalState = "LOCKED"
  /\ refundMatured
  /\ recoveryBundle
  /\ userHasKey
  /\ recoveryEnabled
  /\ principalState' = "REFUND_BROADCAST"
  /\ UNCHANGED <<refundMatured, recoveryBundle, userHasKey, recoveryEnabled,
                  exchangeAvailable, feeCollectorAvailable, kycAvailable,
                  mode, newLocksEnabled>>

ConfirmRefund ==
  /\ principalState = "REFUND_BROADCAST"
  /\ principalState' = "REFUNDED"
  /\ UNCHANGED <<refundMatured, recoveryBundle, userHasKey, recoveryEnabled,
                  exchangeAvailable, feeCollectorAvailable, kycAvailable,
                  mode, newLocksEnabled>>

Next ==
  \/ ExchangeOutage
  \/ FeeCollectorOutage
  \/ KycOutage
  \/ BeginTransition
  \/ AdvanceRefundTime
  \/ BroadcastRefund
  \/ ConfirmRefund

TypeOK ==
  /\ refundMatured \in BOOLEAN
  /\ recoveryBundle \in BOOLEAN
  /\ userHasKey \in BOOLEAN
  /\ recoveryEnabled \in BOOLEAN
  /\ exchangeAvailable \in BOOLEAN
  /\ feeCollectorAvailable \in BOOLEAN
  /\ kycAvailable \in BOOLEAN
  /\ mode \in Modes
  /\ newLocksEnabled \in BOOLEAN
  /\ principalState \in PrincipalStates

RecoveryNeverDisabled == recoveryEnabled

LockedPrincipalKeepsRecoveryMaterial ==
  principalState = "LOCKED" =>
    /\ recoveryBundle
    /\ userHasKey
    /\ recoveryEnabled

ExchangeCannotGateRefund ==
  (~exchangeAvailable /\ refundMatured /\ principalState = "LOCKED")
    => recoveryEnabled

FeeCannotGatePrincipalRecovery ==
  (~feeCollectorAvailable /\ principalState \in {"LOCKED", "REFUND_BROADCAST"})
    => recoveryEnabled

KycCannotGatePrincipalRecovery ==
  (~kycAvailable /\ principalState \in {"LOCKED", "REFUND_BROADCAST"})
    => recoveryEnabled

TransitionCannotGatePrincipalRecovery ==
  (mode = "TRANSITION" /\ principalState \in {"LOCKED", "REFUND_BROADCAST"})
    => recoveryEnabled

RefundRequiresRecoveryMaterial ==
  principalState \in {"REFUND_BROADCAST", "REFUNDED"} =>
    /\ recoveryBundle
    /\ userHasKey
    /\ recoveryEnabled

Spec == Init /\ [][Next]_vars

ComposedFaultInit ==
  /\ refundMatured = FALSE
  /\ recoveryBundle = TRUE
  /\ userHasKey = TRUE
  /\ recoveryEnabled = TRUE
  /\ exchangeAvailable = FALSE
  /\ feeCollectorAvailable = FALSE
  /\ kycAvailable = FALSE
  /\ mode = "TRANSITION"
  /\ newLocksEnabled = FALSE
  /\ principalState = "LOCKED"

ComposedFaultNext ==
  \/ AdvanceRefundTime
  \/ BroadcastRefund
  \/ ConfirmRefund

ComposedFaultSpec ==
  /\ ComposedFaultInit
  /\ [][ComposedFaultNext]_vars
  /\ WF_vars(AdvanceRefundTime)
  /\ WF_vars(BroadcastRefund)
  /\ WF_vars(ConfirmRefund)

HonestRecoveryPath ==
  <> (principalState = "REFUNDED")

RecoveryDuringMarketplaceStop ==
  []((~exchangeAvailable /\ principalState \in {"LOCKED", "REFUND_BROADCAST"})
      => recoveryEnabled)

====
