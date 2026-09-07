# Current physical qualification — PC A ↔ PC B

Status: **NOT YET PASSED for the current release**.

This document is the release gate for claiming that the current GPUbnb PC A ↔ PC B rental path is physically qualified. Historical runs, simulators, unit tests, CI, and an older `GPU_DIAGNOSTIC` result do not satisfy this gate.

## Release identity

A qualification result is valid only for one exact tested release identity. Record before starting:

- Git commit SHA deployed by the API/control plane;
- Agent version and build commit reported by PC A;
- frontend build/release identity visible to PC B;
- API origin and workspace gateway origin actually used;
- Redis provider/endpoint class and PostgreSQL target class, without recording credentials;
- PC A OS, Docker version, NVIDIA driver and physical GPU UUID/model.

If any executable component changes after the run, the result becomes historical evidence and this gate returns to **NOT YET PASSED** until the affected path is requalified.

## Required physical setup

- PC A: a real host machine running the release Agent, Docker and NVIDIA runtime, with a physical NVIDIA GPU published by GPUbnb.
- PC B: a distinct renter browser/session. Do not reuse PC A's authenticated host session as the renter proof.
- The test must use the normal public frontend/API/gateway routing configured for the release. No localhost-only shortcut may count as the final proof.
- Use the approved private-beta/devnet payment mode for the release. This document does not authorize mainnet or real-money testing.

## Mandatory end-to-end run

All steps below must pass in one coherent rental lifecycle:

1. PC A is online, heartbeat is fresh, Docker/NVIDIA probes are healthy, the target GPU is available, and the listing is bookable.
2. PC B books the real PC A GPU for a short controlled rental window.
3. The server allocates the exact GPU resource and the booking reaches the expected funded/starting state for the approved beta payment mode.
4. A `GPU_PROOF` job is claimed by PC A using a valid fenced job attempt/lease.
5. `GPU_PROOF` completes successfully on the exact leased physical GPU UUID; no different GPU may satisfy the proof.
6. The Developer Workspace enters preparation only after GPU proof succeeds.
7. PC A starts/adopts exactly one workspace runtime for the session and registers a fresh gateway.
8. PC B reaches the workspace-ready state and the UI exposes **Ouvrir mon espace** only when `canOpen` is truly satisfied.
9. PC B clicks **Ouvrir mon espace** and reaches the actual code-server workspace through the configured public gateway path.
10. Inside the renter workspace, run `nvidia-smi` and record evidence that the visible GPU is the exact leased GPU.
11. Keep the workspace active long enough to prove heartbeat/gateway liveness does not flap under normal use and that authenticated workspace traffic is flowing.
12. Stop the rental through the normal renter/owner lifecycle; do not manually delete the container as the success path.
13. PC A confirms workspace container, proxy, per-session volume and per-session network cleanup. The runtime-cleanliness diagnostic must not report an orphan.
14. Booking/workspace/jobs reach terminal states without an invalid transition, stale attempt, duplicate terminal mutation or unexpected quarantine.
15. The physical GPU resource and listing return to the expected available/bookable state.

## Required evidence

Store only non-secret evidence. The qualification record must contain:

- UTC start/end timestamps;
- release Git SHA and Agent version/build commit;
- booking ID, GPU_PROOF job ID and workspace session ID;
- machine ID and leased accelerator hardware UUID;
- state transition timeline for booking, job, workspace and machine availability;
- `GPU_PROOF` success evidence tied to the leased hardware UUID;
- screenshot or sanitized terminal capture from PC B showing `nvidia-smi` inside the opened workspace;
- sanitized correlation/request IDs covering the open-workspace attempt;
- cleanup evidence showing no unexpected GPUbnb per-session Docker resources;
- final listing/resource availability evidence;
- any network interruption or retry observed during the run.

Never store session cookies, authorization headers, Redis credentials, Supabase service credentials, workspace bootstrap grants, lease tokens, private keys or full signed authentication payloads.

## Fail conditions

The qualification is **FAILED**, not “mostly passed”, if any of these happens:

- PC B cannot open the workspace without manual server/database mutation;
- the UI says openable while gateway, heartbeat, lease or workspace readiness is stale;
- `GPU_PROOF` runs on a GPU other than the leased hardware UUID;
- a job lease expires during ordinary healthy operation;
- the Agent or API requires a manual restart to continue the same healthy rental;
- a duplicate runtime is created for one workspace session;
- a stale job attempt can update terminal state;
- PC B loses the workspace under ordinary heartbeat jitter with no real Host outage;
- stop/cleanup leaves an unexpected GPUbnb container, proxy, per-session volume or per-session network;
- the listing becomes bookable before cleanup/resource release is actually complete;
- the machine is auto-cleared from quarantine without mandatory diagnostic proof;
- any secret is exposed in browser-visible data, logs or the evidence package.

## Fault campaign after the clean run

A clean run is mandatory first. Then execute controlled failures separately; they do not replace the clean run:

- brief API/network interruption shorter than the qualified job lease margin;
- browser reconnect while the workspace remains healthy;
- Agent process restart with an existing legitimate workspace runtime;
- gateway reconnect/resume;
- repeated stop request/idempotent cleanup;
- deliberately leave a GPUbnb-named orphan in a disposable test setup and confirm `runtimeCleanup` prevents automatic unquarantine until it is removed.

Each injected fault must have a written expected state transition and must not transfer business authority to PC A local state.

## Pass decision

Set this document's status to **PASSED** only after one current-release clean run completes all mandatory steps and the evidence above is attached or referenced in a dedicated result document. Record the exact release SHA in that result.

Until then, the correct project statement is:

> Automated qualification is green, but current-release physical PC A ↔ PC B qualification is pending.
