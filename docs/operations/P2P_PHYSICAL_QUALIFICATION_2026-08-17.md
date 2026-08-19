# P2P physical qualification — 2026-08-17

## Scope

This document records physical qualification evidence for the direct QUIC P2P path implemented by PR #122 and the qualification-only ticket tooling in PR #123.

The evidence intentionally excludes private signing keys, TLS private keys, raw endpoint lists, and other secrets.

## Software under qualification

- PR #122: `feat(p2p): direct QUIC session v1`
- PR #123: `feat(p2p): add qualification ticket issuer`
- Direct policy: `DIRECT_ONLY`
- Signed rendezvous ticket maximum TTL: 120 seconds
- Candidate Discovery socket is preserved into the QUIC attempt path by the implementation under test.

## Test 1 — same-network smoke qualification

Purpose: validate the complete qualification flow before the Internet run.

Observed HOST result:

```json
{"latencyMs":1043,"result":"DIRECT_HOST","role":"HOST","success":true}
```

Observed RENTER result:

```json
{"attempts":1,"candidateKind":"HOST","failureCode":null,"fallbackRequired":false,"latencyMs":500,"reconnect":false,"result":"DIRECT_HOST","role":"RENTER","success":true}
```

Result: authenticated direct QUIC session established successfully with no relay fallback.

## Test 2 — real two-network Internet qualification

### Physical topology

- PC A: HOST connected through the home Internet connection.
- PC B: RENTER connected to an iPhone 4G/5G hotspot.
- The RENTER hotspot association was explicitly checked immediately before the qualification run.
- Rendezvous artifacts were exchanged over HTTPS.
- Relay policy remained `DIRECT_ONLY`.

### Observed HOST result

```json
{"latencyMs":3850,"result":"DIRECT_HOST","role":"HOST","success":true}
```

### Observed RENTER result

```json
{"attempts":2,"candidateKind":"HOST","failureCode":null,"fallbackRequired":false,"latencyMs":3453,"reconnect":false,"result":"DIRECT_HOST","role":"RENTER","success":true}
```

### Qualification conclusion

The direct QUIC path established a real authenticated peer-to-peer session between two physical Windows machines on two different Internet access networks.

Evidence from both roles confirms:

- `success=true`
- direct path selected (`DIRECT_HOST`)
- no relay fallback (`fallbackRequired=false` on RENTER)
- signed qualification ticket accepted
- authenticated QUIC session completed on both peers

This satisfies the previously missing real two-network direct Internet qualification for the current P2P implementation.

## What this result does not prove

The successful Internet run selected a `HOST` candidate. Therefore this evidence does **not** by itself prove all NAT traversal classes.

Still to qualify separately:

- IPv4 hole punching through a `SERVER_REFLEXIVE` candidate
- symmetric NAT behavior
- CGNAT combinations
- restrictive firewall behavior
- IPv6-only / IPv4-only combinations
- fallback relay behavior when direct connectivity is impossible
- revocation and failure behavior during a live Internet session

A `DIRECT_HOST` success across two independent Internet access networks is a valid proof of real direct Internet P2P connectivity, but it must not be described as universal NAT traversal coverage.

## Test 3 — physical host GPU_PROOF runner qualification

### Physical host

- PC A physical GPU: `NVIDIA GeForce GTX 1650`
- GPU UUID: `GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a`
- VRAM: 4096 MiB
- Docker Desktop Linux engine: `29.7.2`
- NVIDIA container passthrough had already been verified successfully with an NVIDIA CUDA container.

### Official immutable workload image

```text
ghcr.io/khemisset18/gpu-proof-workspace@sha256:8ac92e956dd7f6a0c55ef6f24165165d16d519e995e0847fd6f42a72ce1ea662
```

The initial uncached image acquisition exposed a runtime issue: for a 30-second proof, `run_gpu_proof_workspace()` gives `_pull_image()` a 150-second timeout, while the physical first pull on PC A required about 280 seconds. The image was therefore pre-fetched with the Agent image-pull implementation using a larger timeout before executing the workload.

### Actual GPUbnb runner execution

The real `gpubnb_agent.runner.run_gpu_proof_workspace()` path was executed for 30 seconds.

Observed samples:

```text
elapsedSeconds=5  iterations=1259
elapsedSeconds=10 iterations=2514
elapsedSeconds=15 iterations=3743
elapsedSeconds=20 iterations=4997
elapsedSeconds=25 iterations=6220
elapsedSeconds=30 iterations=7441
```

Final result:

```json
{
  "gpuDetected": true,
  "summary": "Calcul CUDA GPU Proof terminé et nettoyé.",
  "metrics": {
    "durationSeconds": 30,
    "iterations": 7441,
    "device": "NVIDIA GeForce GTX 1650",
    "containerCleaned": true
  }
}
```

### Qualification conclusion

This proves that the actual GPUbnb host runner executed a real CUDA workload on the physical GTX 1650 for 30 seconds and verified container cleanup.

Two product-integration defects were exposed by the qualification:

1. `workspaceSlug="compute"` currently falls back to `diagnosticImage` when `workspaceImages.compute` is absent, while `GPU_PROOF` requires the official pinned `gpu-proof-workspace` image.
2. The first uncached GPU_PROOF image pull can exceed the current 150-second timeout for a 30-second proof workload.

These two host-runtime defects were corrected by the stacked GPU proof runtime qualification change before the product-level E2E attempt.

This host-side workload proof is separate from the direct-P2P transport qualification. It does **not** by itself prove that workload bytes traversed the direct P2P QUIC data path.

## Test 4 — private-beta payment-to-GPU_PROOF routing regression qualification

### Integration defect found before the physical product E2E

The private-beta payment bypass and the historical first-rental diagnostic shared the same development reconciler. With `BETA_TEST_DEV_BYPASS=true` and `ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET`, one reconciliation pass could both:

1. move an `AWAITING_DEPOSIT` booking to `FUNDED` and mark its payment `ESCROW_FUNDED`; and
2. immediately select that same booking for the legacy `GPU_DIAGNOSTIC` path.

That behavior conflicts with the current product flow, where the authenticated renter requests the `compute` workspace and `ensureComputePreparation()` creates the `GPU_PROOF` job. There is no reliable manual timing window between the funding and legacy diagnostic steps because they occur in the same reconciler invocation.

### Corrective change

Commit `48ac4fc` (`fix(api): route beta bypass to compute proof flow`) separates detection of the bounded private-beta bypass from the historical development bypass.

For the private-beta bypass only:

- funding still occurs only while `ESCROW_PROGRAM_ID` is the `NOT_DEPLOYED_YET` placeholder;
- the booking can still transition from `AWAITING_DEPOSIT` to `FUNDED` with `ESCROW_FUNDED` payment state;
- the reconciler skips the legacy `GPU_DIAGNOSTIC` queue;
- the real authenticated `POST /bookings/:bookingId/workspace-sessions` route with `{"workspaceSlug":"compute"}` remains the entry point for `ensureComputePreparation()` and `GPU_PROOF` creation;
- the historical non-production `DEV_PAYMENT_BYPASS` diagnostic behavior remains unchanged.

### Regression evidence

Targeted reconciler/race tests:

```text
tests 4
pass 4
fail 0
skipped 0
```

The added regression explicitly verifies that the bounded beta bypass does not inspect or enqueue legacy `GPU_DIAGNOSTIC` work.

Developer lifecycle regression file after adapting its source marker to the guarded `readyBookings` expression:

```text
tests 8
pass 8
fail 0
skipped 0
```

Full API suite:

```text
tests 374
pass 374
fail 0
skipped 0
```

API build:

```text
prisma generate && tsc -p tsconfig.json
```

completed successfully with no TypeScript error.

### Qualification conclusion and caveat

This software qualification removes the deterministic conflict between the private-beta funding shortcut and the intended `compute`/`GPU_PROOF` preparation route without weakening the real-escrow guard.

It is **not** yet a physical end-to-end rental proof. At this point PC B has not been used for the product-level booking flow, and this evidence does not prove that an installed Host Agent service is executing the newly qualified branch code. Those items must be checked in the physical E2E before claiming a completed rental flow.

## Next product-level qualification

The next milestone is a real end-to-end GPU rental workload over the qualified system:

1. create / acquire a valid reservation and lease;
2. establish the signed direct P2P session;
3. submit a real GPU workload from the RENTER;
4. execute it on the HOST GPU;
5. return workload output to the RENTER;
6. verify lease/fencing enforcement during execution;
7. capture metering and completion evidence;
8. test failure/revocation behavior;
9. repeat on at least one additional network/NAT topology.

Only after that workload-level evidence should the project claim a fully functioning rental flow rather than only a functioning direct transport path plus a separately qualified physical GPU runner.
