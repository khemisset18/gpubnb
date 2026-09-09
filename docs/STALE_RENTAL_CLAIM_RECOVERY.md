# Quarantine recovery and stale rental claims

## Stale local rental claim problem

Older Windows Host builds can retain `gpu-resource-rental-v1.json` and
`gpu-resource-runtime-v1.json` records in `QUARANTINED` after the server has
legitimately retired the old rental and later cleared Machine/Accelerator
moderation through the diagnostic system. A subsequent signed rental authority
then fails locally before workspace runtime creation because the old claim tuple
differs from the new session/lease.

Deleting those files is not an acceptable recovery protocol: it discards the
local fencing evidence and could allow a stale or ambiguous authority to reuse a
GPU.

## Qualified stale-claim recovery rule

The Agent may supersede a local `QUARANTINED` claim only when **all** of these are
true:

1. the resource id is the same;
2. the hardware UUID is the same;
3. the old claim has a valid `rental:<session>` holder;
4. the new authority has a valid `rental:<session>` holder and its fencing token
   exactly equals its runtime generation;
5. the new fencing generation is **strictly greater** than the quarantined one;
6. the new lease id differs from the quarantined lease id;
7. the local runtime is absent, or is `QUARANTINED`/`STOPPED` with no persisted
   PID/process-creation token;
8. local runtime generation is not newer than the new authority, and any
   partially advanced generation is exactly the new authority generation;
9. the physical GPU UUID resolves successfully now;
10. a fresh GPU quiescence proof succeeds before any state mutation.

If any condition is not proven, recovery is refused and the existing fail-closed
preemption behavior remains authoritative.

## Crash ordering

After fresh physical proof, recovery advances the runtime to `STOPPED` at the
new generation, then replaces the old claim with the exact new tuple in
`PREEMPTING`. The already-qualified `preempt_for_rental()` implementation then
runs normally, re-proves GPU quiescence and transitions the claim to `QUIESCENT`.

This ordering is restart-safe:

- crash before physical proof: no state changed;
- crash after runtime advance but before claim replacement: the next attempt
  re-proves the GPU and may resume only the same exact new generation;
- crash after `PREEMPTING`: canonical preemption resumes the exact tuple;
- equal/older fences and ambiguous intermediate generations remain blocked.

## Thermal policy

Temperature alone enters **server quarantine only at 98 C or above**. A measured
97.999 C does not enter thermal quarantine.

This is intentionally separate from local workload protection. Host Desktop may
stop mining conservatively at a lower temperature to protect the physical GPU;
that local protective stop is not a Machine quarantine and now rearms
automatically after a real cooldown sample.

At the 98 C boundary the server persists the exact measured temperature, GPU
hardware UUID and thresholds in immutable quarantine history. It never replaces
an already-active unrelated security/cleanup quarantine with a thermal label.

A thermal quarantine never clears merely because a later heartbeat is cooler.
Once a heartbeat proves the GPU has cooled to 90 C or below, GPUbnb automatically
queues a real signed DiagnosticRun. The diagnostic may clear quarantine only if
all normal mandatory checks pass **and** the latest heartbeat still proves the
thermal cooldown. No ProgramData editing or manual acknowledgement is required.

## Owner UX

The machine diagnostics screen puts the durable event reason at the top as
`Cause détectée`. While quarantined it exposes one primary action:
`Résoudre automatiquement`.

That action applies only a server-approved safe bookkeeping repair when one is
available, then starts the real diagnostic automatically. It never calls the
administrator force-clear endpoint and never edits local state files. Thermal
quarantine normally begins its diagnostic automatically after cooldown, so the
owner often does not need to click anything at all.

## Explicit non-goals

This does **not** bypass server-side security quarantine, delete ProgramData
state, force-stop unknown processes, weaken mining/rental exclusivity, or recover
a runtime that still has process identity metadata.
