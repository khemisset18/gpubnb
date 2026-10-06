---- MODULE AssetExchangeSpendRaceV1 ----
EXTENDS TLC

ObservedSpendStates == {"UNSPENT", "REDEEM", "REFUND"}
TerminalStates == {"ACTIVE", "COMPLETED", "REFUNDED"}

VARIABLES
  refundMatured,
  redeemBroadcast,
  refundBroadcast,
  redeemConfirmed,
  refundConfirmed,
  observedSpend,
  terminalState,
  recoveryEnabled

vars == <<refundMatured, redeemBroadcast, refundBroadcast, redeemConfirmed,
          refundConfirmed, observedSpend, terminalState, recoveryEnabled>>

Init ==
  /\ refundMatured = FALSE
  /\ redeemBroadcast = FALSE
  /\ refundBroadcast = FALSE
  /\ redeemConfirmed = FALSE
  /\ refundConfirmed = FALSE
  /\ observedSpend = "UNSPENT"
  /\ terminalState = "ACTIVE"
  /\ recoveryEnabled = TRUE

AdvanceRefundTime ==
  /\ ~refundMatured
  /\ refundMatured' = TRUE
  /\ UNCHANGED <<redeemBroadcast, refundBroadcast, redeemConfirmed,
                  refundConfirmed, observedSpend, terminalState, recoveryEnabled>>

BroadcastRedeem ==
  /\ ~redeemBroadcast
  /\ redeemBroadcast' = TRUE
  /\ UNCHANGED <<refundMatured, refundBroadcast, redeemConfirmed,
                  refundConfirmed, observedSpend, terminalState, recoveryEnabled>>

BroadcastRefund ==
  /\ refundMatured
  /\ ~refundBroadcast
  /\ refundBroadcast' = TRUE
  /\ UNCHANGED <<refundMatured, redeemBroadcast, redeemConfirmed,
                  refundConfirmed, observedSpend, terminalState, recoveryEnabled>>

ConfirmRedeem ==
  /\ redeemBroadcast
  /\ ~redeemConfirmed
  /\ ~refundConfirmed
  /\ redeemConfirmed' = TRUE
  /\ UNCHANGED <<refundMatured, redeemBroadcast, refundBroadcast,
                  refundConfirmed, observedSpend, terminalState, recoveryEnabled>>

ConfirmRefund ==
  /\ refundBroadcast
  /\ ~redeemConfirmed
  /\ ~refundConfirmed
  /\ refundConfirmed' = TRUE
  /\ UNCHANGED <<refundMatured, redeemBroadcast, refundBroadcast,
                  redeemConfirmed, observedSpend, terminalState, recoveryEnabled>>

ObserveRedeem ==
  /\ redeemConfirmed
  /\ observedSpend = "UNSPENT"
  /\ observedSpend' = "REDEEM"
  /\ UNCHANGED <<refundMatured, redeemBroadcast, refundBroadcast,
                  redeemConfirmed, refundConfirmed, terminalState, recoveryEnabled>>

ObserveRefund ==
  /\ refundConfirmed
  /\ observedSpend = "UNSPENT"
  /\ observedSpend' = "REFUND"
  /\ UNCHANGED <<refundMatured, redeemBroadcast, refundBroadcast,
                  redeemConfirmed, refundConfirmed, terminalState, recoveryEnabled>>

ConvergeCompleted ==
  /\ terminalState = "ACTIVE"
  /\ observedSpend = "REDEEM"
  /\ terminalState' = "COMPLETED"
  /\ UNCHANGED <<refundMatured, redeemBroadcast, refundBroadcast,
                  redeemConfirmed, refundConfirmed, observedSpend, recoveryEnabled>>

ConvergeRefunded ==
  /\ terminalState = "ACTIVE"
  /\ observedSpend = "REFUND"
  /\ terminalState' = "REFUNDED"
  /\ UNCHANGED <<refundMatured, redeemBroadcast, refundBroadcast,
                  redeemConfirmed, refundConfirmed, observedSpend, recoveryEnabled>>

Next ==
  \/ AdvanceRefundTime
  \/ BroadcastRedeem
  \/ BroadcastRefund
  \/ ConfirmRedeem
  \/ ConfirmRefund
  \/ ObserveRedeem
  \/ ObserveRefund
  \/ ConvergeCompleted
  \/ ConvergeRefunded

TypeOK ==
  /\ refundMatured \in BOOLEAN
  /\ redeemBroadcast \in BOOLEAN
  /\ refundBroadcast \in BOOLEAN
  /\ redeemConfirmed \in BOOLEAN
  /\ refundConfirmed \in BOOLEAN
  /\ observedSpend \in ObservedSpendStates
  /\ terminalState \in TerminalStates
  /\ recoveryEnabled \in BOOLEAN

NoDoubleSpend == ~(redeemConfirmed /\ refundConfirmed)
RefundOnlyAfterMaturity == refundBroadcast => refundMatured
ObservationConsistent ==
  /\ (observedSpend = "REDEEM" => redeemConfirmed)
  /\ (observedSpend = "REFUND" => refundConfirmed)
TerminalConsistent ==
  /\ (terminalState = "COMPLETED" => (redeemConfirmed /\ observedSpend = "REDEEM"))
  /\ (terminalState = "REFUNDED" => (refundConfirmed /\ observedSpend = "REFUND"))
RecoveryNeverDisabled == recoveryEnabled

Spec == Init /\ [][Next]_vars

RaceInit ==
  /\ refundMatured = TRUE
  /\ redeemBroadcast = TRUE
  /\ refundBroadcast = TRUE
  /\ redeemConfirmed = FALSE
  /\ refundConfirmed = FALSE
  /\ observedSpend = "UNSPENT"
  /\ terminalState = "ACTIVE"
  /\ recoveryEnabled = TRUE

RaceNext ==
  \/ ConfirmRedeem
  \/ ConfirmRefund
  \/ ObserveRedeem
  \/ ObserveRefund
  \/ ConvergeCompleted
  \/ ConvergeRefunded

RaceSpec ==
  /\ RaceInit
  /\ [][RaceNext]_vars
  /\ WF_vars(ConfirmRedeem)
  /\ WF_vars(ConfirmRefund)
  /\ WF_vars(ObserveRedeem)
  /\ WF_vars(ObserveRefund)
  /\ WF_vars(ConvergeCompleted)
  /\ WF_vars(ConvergeRefunded)

RaceEventuallyConverges ==
  <> (terminalState \in {"COMPLETED", "REFUNDED"})

====