---- MODULE AssetExchangeTermsV1 ----
EXTENDS TLC

CONSTANTS TermsA, TermsB, FeeA, FeeB

Terms == {TermsA, TermsB}
FeeTerms == {FeeA, FeeB}

VARIABLES
  signed,
  currentTerms,
  currentFeeTerms,
  signedTerms,
  signedFeeTerms,
  mutationRejected,
  lockStarted

vars == <<signed, currentTerms, currentFeeTerms, signedTerms, signedFeeTerms,
          mutationRejected, lockStarted>>

Init ==
  /\ signed = FALSE
  /\ currentTerms \in Terms
  /\ currentFeeTerms \in FeeTerms
  /\ signedTerms = currentTerms
  /\ signedFeeTerms = currentFeeTerms
  /\ mutationRejected = FALSE
  /\ lockStarted = FALSE

PreSignMutate(t, f) ==
  /\ ~signed
  /\ t \in Terms
  /\ f \in FeeTerms
  /\ currentTerms' = t
  /\ currentFeeTerms' = f
  /\ signedTerms' = signedTerms
  /\ signedFeeTerms' = signedFeeTerms
  /\ UNCHANGED <<signed, mutationRejected, lockStarted>>

SignTerms ==
  /\ ~signed
  /\ signed' = TRUE
  /\ signedTerms' = currentTerms
  /\ signedFeeTerms' = currentFeeTerms
  /\ mutationRejected' = FALSE
  /\ UNCHANGED <<currentTerms, currentFeeTerms, lockStarted>>

AttemptPostSignMutation(t, f) ==
  /\ signed
  /\ t \in Terms
  /\ f \in FeeTerms
  /\ (t # currentTerms \/ f # currentFeeTerms)
  /\ mutationRejected' = TRUE
  /\ UNCHANGED <<signed, currentTerms, currentFeeTerms, signedTerms,
                  signedFeeTerms, lockStarted>>

StartLock ==
  /\ signed
  /\ ~lockStarted
  /\ currentTerms = signedTerms
  /\ currentFeeTerms = signedFeeTerms
  /\ lockStarted' = TRUE
  /\ UNCHANGED <<signed, currentTerms, currentFeeTerms, signedTerms,
                  signedFeeTerms, mutationRejected>>

Next ==
  \/ \E t \in Terms, f \in FeeTerms: PreSignMutate(t, f)
  \/ SignTerms
  \/ \E t \in Terms, f \in FeeTerms: AttemptPostSignMutation(t, f)
  \/ StartLock

TypeOK ==
  /\ signed \in BOOLEAN
  /\ currentTerms \in Terms
  /\ currentFeeTerms \in FeeTerms
  /\ signedTerms \in Terms
  /\ signedFeeTerms \in FeeTerms
  /\ mutationRejected \in BOOLEAN
  /\ lockStarted \in BOOLEAN

TermsImmutable ==
  signed => currentTerms = signedTerms

FeeTermsImmutable ==
  signed => currentFeeTerms = signedFeeTerms

LockUsesSignedTerms ==
  lockStarted =>
    /\ signed
    /\ currentTerms = signedTerms
    /\ currentFeeTerms = signedFeeTerms

PostSignMutationCannotChangeTerms ==
  mutationRejected =>
    /\ currentTerms = signedTerms
    /\ currentFeeTerms = signedFeeTerms

Spec == Init /\ [][Next]_vars

====
