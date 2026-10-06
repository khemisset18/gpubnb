---- MODULE AssetExchangeFaultsV1 ----
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS TradeA, TradeB

Trades == {TradeA, TradeB}
EvidenceStates == {"UNKNOWN", "CONSISTENT", "UNCERTAIN", "CONFLICT"}

VARIABLES
  intentDurable,
  workerUp,
  effectCount,
  resultRecorded,
  authConsumed,
  acceptedTrades,
  replayRejected,
  evidence,
  irreversibleCount,
  advanceEvidence,
  recoveryEnabled

vars == <<intentDurable, workerUp, effectCount, resultRecorded, authConsumed,
          acceptedTrades, replayRejected, evidence, irreversibleCount,
          advanceEvidence, recoveryEnabled>>

Init ==
  /\ intentDurable = FALSE
  /\ workerUp = TRUE
  /\ effectCount = 0
  /\ resultRecorded = FALSE
  /\ authConsumed = FALSE
  /\ acceptedTrades = {}
  /\ replayRejected = FALSE
  /\ evidence = "UNKNOWN"
  /\ irreversibleCount = 0
  /\ advanceEvidence = "UNKNOWN"
  /\ recoveryEnabled = TRUE

PersistIntent ==
  /\ workerUp
  /\ ~intentDurable
  /\ intentDurable' = TRUE
  /\ UNCHANGED <<workerUp, effectCount, resultRecorded, authConsumed,
                  acceptedTrades, replayRejected, evidence, irreversibleCount,
                  advanceEvidence, recoveryEnabled>>

BroadcastEffect ==
  /\ workerUp
  /\ intentDurable
  /\ effectCount = 0
  /\ effectCount' = 1
  /\ UNCHANGED <<intentDurable, workerUp, resultRecorded, authConsumed,
                  acceptedTrades, replayRejected, evidence, irreversibleCount,
                  advanceEvidence, recoveryEnabled>>

DuplicateBroadcastDelivery ==
  /\ workerUp
  /\ intentDurable
  /\ effectCount = 1
  /\ effectCount' = effectCount
  /\ UNCHANGED <<intentDurable, workerUp, resultRecorded, authConsumed,
                  acceptedTrades, replayRejected, evidence, irreversibleCount,
                  advanceEvidence, recoveryEnabled>>

RecordBroadcastResult ==
  /\ workerUp
  /\ effectCount = 1
  /\ ~resultRecorded
  /\ resultRecorded' = TRUE
  /\ UNCHANGED <<intentDurable, workerUp, effectCount, authConsumed,
                  acceptedTrades, replayRejected, evidence, irreversibleCount,
                  advanceEvidence, recoveryEnabled>>

CrashWorker ==
  /\ workerUp
  /\ workerUp' = FALSE
  /\ UNCHANGED <<intentDurable, effectCount, resultRecorded, authConsumed,
                  acceptedTrades, replayRejected, evidence, irreversibleCount,
                  advanceEvidence, recoveryEnabled>>

RestartWorker ==
  /\ ~workerUp
  /\ workerUp' = TRUE
  /\ UNCHANGED <<intentDurable, effectCount, resultRecorded, authConsumed,
                  acceptedTrades, replayRejected, evidence, irreversibleCount,
                  advanceEvidence, recoveryEnabled>>

ReconcileExistingEffect ==
  /\ workerUp
  /\ intentDurable
  /\ effectCount = 1
  /\ ~resultRecorded
  /\ resultRecorded' = TRUE
  /\ UNCHANGED <<intentDurable, workerUp, effectCount, authConsumed,
                  acceptedTrades, replayRejected, evidence, irreversibleCount,
                  advanceEvidence, recoveryEnabled>>

AttemptAuthorization(t) ==
  /\ t \in Trades
  /\ ~authConsumed
  /\ IF t = TradeA
        THEN
          /\ authConsumed' = TRUE
          /\ acceptedTrades' = acceptedTrades \cup {t}
          /\ replayRejected' = replayRejected
        ELSE
          /\ authConsumed' = authConsumed
          /\ acceptedTrades' = acceptedTrades
          /\ replayRejected' = TRUE
  /\ UNCHANGED <<intentDurable, workerUp, effectCount, resultRecorded,
                  evidence, irreversibleCount, advanceEvidence, recoveryEnabled>>

ReplayAttempt(t) ==
  /\ t \in Trades
  /\ authConsumed
  /\ replayRejected' = TRUE
  /\ UNCHANGED <<intentDurable, workerUp, effectCount, resultRecorded,
                  authConsumed, acceptedTrades, evidence, irreversibleCount,
                  advanceEvidence, recoveryEnabled>>

ObserveEvidence(e) ==
  /\ e \in EvidenceStates
  /\ evidence' = e
  /\ UNCHANGED <<intentDurable, workerUp, effectCount, resultRecorded,
                  authConsumed, acceptedTrades, replayRejected,
                  irreversibleCount, advanceEvidence, recoveryEnabled>>

AdvanceIrreversible ==
  /\ evidence = "CONSISTENT"
  /\ irreversibleCount = 0
  /\ irreversibleCount' = 1
  /\ advanceEvidence' = evidence
  /\ UNCHANGED <<intentDurable, workerUp, effectCount, resultRecorded,
                  authConsumed, acceptedTrades, replayRejected, evidence,
                  recoveryEnabled>>

Next ==
  \/ PersistIntent
  \/ BroadcastEffect
  \/ DuplicateBroadcastDelivery
  \/ RecordBroadcastResult
  \/ CrashWorker
  \/ RestartWorker
  \/ ReconcileExistingEffect
  \/ \E t \in Trades: AttemptAuthorization(t)
  \/ \E t \in Trades: ReplayAttempt(t)
  \/ \E e \in EvidenceStates: ObserveEvidence(e)
  \/ AdvanceIrreversible

TypeOK ==
  /\ intentDurable \in BOOLEAN
  /\ workerUp \in BOOLEAN
  /\ effectCount \in 0..2
  /\ resultRecorded \in BOOLEAN
  /\ authConsumed \in BOOLEAN
  /\ acceptedTrades \subseteq Trades
  /\ replayRejected \in BOOLEAN
  /\ evidence \in EvidenceStates
  /\ irreversibleCount \in 0..1
  /\ advanceEvidence \in EvidenceStates
  /\ recoveryEnabled \in BOOLEAN

CrashIdempotency == effectCount <= 1
IntentBeforeEffect == effectCount = 1 => intentDurable
NoResultBeforeEffect == resultRecorded => effectCount = 1
ReplayIsolation == acceptedTrades \subseteq {TradeA}
SingleAuthorization == Cardinality(acceptedTrades) <= 1
UncertainChainStopsAdvance ==
  irreversibleCount = 1 => advanceEvidence = "CONSISTENT"
RecoveryNeverDisabled == recoveryEnabled

Spec == Init /\ [][Next]_vars

CrashRecoveryInit ==
  /\ intentDurable = TRUE
  /\ workerUp = FALSE
  /\ effectCount = 1
  /\ resultRecorded = FALSE
  /\ authConsumed = FALSE
  /\ acceptedTrades = {}
  /\ replayRejected = FALSE
  /\ evidence = "UNKNOWN"
  /\ irreversibleCount = 0
  /\ advanceEvidence = "UNKNOWN"
  /\ recoveryEnabled = TRUE

CrashRecoveryNext ==
  \/ RestartWorker
  \/ ReconcileExistingEffect

CrashRecoverySpec ==
  /\ CrashRecoveryInit
  /\ [][CrashRecoveryNext]_vars
  /\ WF_vars(RestartWorker)
  /\ WF_vars(ReconcileExistingEffect)

CrashEventuallyReconciled ==
  <> (resultRecorded /\ effectCount = 1)

====