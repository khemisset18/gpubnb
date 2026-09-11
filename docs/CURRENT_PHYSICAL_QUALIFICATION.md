# Current physical qualification — PC A ↔ PC B

Status: **HOST/WORKSPACE PHYSICAL BASELINE PASSED on `host-v0.2.0-beta.85` / Agent `0.6.6`; full all-component release identity lock remains pending**.

The validated Host/Workspace/GPU/cleanup result is frozen in `docs/PHYSICAL_BASELINE_2026-09-11_BETA85.md` and by branch `baseline/physical-pass-beta85-2026-09-11` at commit `4615a880752a8a97c161c4a37f0f50bf6f1bca03`.

The physical product path has now passed on real PC A ↔ PC B: the renter opened a usable code-server Workspace, the renter terminal proved the exact leased physical GPU UUID, the rental ended normally, all four classes of per-session Docker resources were absent after stop, and the resource/listing returned to available/bookable.

This document remains the release gate for claiming a **fully locked current deployment**. The final clean run locked the Host/Agent identity but did not independently re-capture a complete API/frontend deployment identity bundle in the same evidence package. Do not silently upgrade the Host/Workspace baseline into an all-component deployment attestation.

Historical runs, simulators, unit tests, CI, and an older `GPU_DIAGNOSTIC` result do not satisfy this gate by themselves.

## Release identity

A full current-release qualification result is valid only for one exact tested release identity. Record before starting:

- Git commit SHA deployed by the API/control plane;
- Agent version and build commit reported by PC A;
- frontend build/release identity visible to PC B;
- API origin and workspace gateway origin actually used;
- Redis provider/endpoint class and PostgreSQL target class, without recording credentials;
- PC A OS, Docker version, NVIDIA driver and physical GPU UUID/model.

If any executable component changes after the run, the affected result becomes historical evidence until that changed component/path is requalified. The frozen beta.85 branch remains a rollback/reference baseline and must not be moved to follow later commits.

## Qualified Host/Workspace baseline

The 2026-09-11 beta.85 run established all of the following on the real Host/Workspace path:

- Host release `host-v0.2.0-beta.85`;
- Agent `0.6.6`, build commit `4615a880752a`;
- public GPUbnb Workspace opened to a usable real code-server environment;
- renter terminal returned exact GPU identity `GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a, NVIDIA GeForce GTX 1650, 592.82, 4096 MiB`;
- normal rental stop completed without manual repair;
- GPU/listing returned to available/bookable;
- post-stop Docker inventory returned no `gpubnb-dev-*`, `gpubnb-dev-proxy-*`, `gpubnb-workspace-*` or `gpubnb-workspace-internal-*` resources.

Detailed record: `docs/PHYSICAL_BASELINE_2026-09-11_BETA85.md`.

## Qualification tooling

`docs/TWO_PC_TEST.md` is the current operator procedure for this gate. Before a clean qualification run:

- run `scripts/qualification-preflight-pc-a.ps1` on PC A to lock the repository/Agent/GPU identity and fail closed on a dirty release, unhealthy Agent/Docker/NVIDIA state, or an old GPUbnb per-session Docker resource;
- run `scripts/qualification-preflight-pc-b.ps1` on PC B to verify the real HTTPS frontend, same-origin `/api` proxy, direct API `/ready`, gateway `/ws-health`, published gateway origin and frontend build commit;
- start `scripts/qualification-evidence.ps1` only after both preflights are PASS. It writes a non-secret release lock and evidence record.

After normal stop, use the same evidence collector in `Finish` mode to bind the booking/job/session/machine/GPU identifiers to the release lock and prove the canonical per-session container/proxy/volume/internal-network resources are absent.

These helpers deliberately do **not** mark a release PASSED by themselves. They do not replace visual confirmation from PC B, server state-transition evidence, or the final manual decision required below. Generated local evidence lives under `qualification-evidence/`, which is gitignored to reduce accidental publication.

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

The beta.85 Host/Workspace baseline has passed the functional portions above. A future full all-component release-lock run should use the tooling to capture the exact API/frontend identity in the same evidence package rather than relying on inference.

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

A clean normal-path run has now passed for the beta.85 Host/Workspace baseline. Controlled failures remain separate qualification work and do not invalidate that normal-path result unless they reveal a defect in the same path.

Next controlled failures include:

- brief API/network interruption shorter than the qualified job lease margin;
- browser reconnect while the workspace remains healthy;
- Agent process restart with an existing legitimate workspace runtime;
- gateway reconnect/resume;
- repeated stop request/idempotent cleanup;
- unexpected Host power loss/reboot during an active rental, tracked in #190;
- deliberately leave a GPUbnb-named orphan in a disposable test setup and confirm `runtimeCleanup` prevents automatic unquarantine until it is removed.

Each injected fault must have a written expected state transition and must not transfer business authority to PC A local state.

## Performance hardening after the pass

Do not destabilize the proven transport by changing generic timeouts or queue bounds without measurement. Issue #191 tracks a measurement-first performance phase: correlate runtime startup, code-server readiness, gateway registration, HTTP asset relay, WebSocket enqueue/dequeue, local handshake, first useful frame, time-to-interactive and cleanup latency, then optimize the measured bottleneck while comparing against the frozen beta.85 baseline.

## Pass decision

The current project statement is:

> Real PC A ↔ PC B Host/Workspace/GPU/cleanup qualification has PASSED on `host-v0.2.0-beta.85` / Agent `0.6.6` / commit `4615a880752a8a97c161c4a37f0f50bf6f1bca03`. The strict all-component deployment lock remains pending until the exact API/frontend release identities are captured in the same qualification evidence bundle.

Any future runtime/transport change must preserve or exceed the behavior recorded in `docs/PHYSICAL_BASELINE_2026-09-11_BETA85.md` before replacing beta.85 as the reference baseline.
