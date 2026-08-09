# GPUbnb Unified Workspace Runtime

## Decision

GPUbnb has thirteen product workspaces, but it will have **one lifecycle engine**, not thirteen unrelated remote-access systems.

Every rental follows the same state machine:

`RESERVED -> PREPARING -> READY -> ACTIVE -> STOPPING -> CLEANUP_VERIFY -> TERMINATED`

Any failed cleanup goes to `QUARANTINED`, never directly back to machine availability.

## Runtime families

### Container family

Used first for Compute, Developer, AI, API and Data.

- Compute: controlled batch jobs.
- Developer: browser IDE (`code-server`) + terminal + Git + Python/Node.
- AI: JupyterLab + CUDA/PyTorch.
- API: renter process exposed only through the GPUbnb gateway.
- Data: JupyterLab + Python/R/data tooling.

Containers run non-root, unprivileged, without Docker socket or host-home mounts. Images must be immutable/pinned. `/workspace` is the only renter-writable project volume.

### Desktop VM family

Used for Cloud Desktop, Creator, Video and CAD. The renter sees a complete isolated desktop through a GPUbnb gateway, not the host's Windows desktop. GPU passthrough/partitioning must be supported and verified before a machine advertises these workspaces.

### Isolated VM family

Used for Mobile and Security Lab. These need a stronger boundary because of nested/emulator workloads or the security tooling threat model. Security Lab has no network by default.

### Streaming VM family

Gaming and Audio remain experimental. They require latency-sensitive video/audio/input streaming and should not block the first useful workspace release.

## Renter experience

The web application should show one consistent flow regardless of runtime family:

1. Workspace card shows `Compatible`, `Limited`, or `Unavailable` for the selected machine.
2. Reservation creates a session and begins preparation automatically.
3. Booking page displays preparation progress.
4. When access policy passes, a single **Open workspace** button appears.
5. The button opens a GPUbnb gateway URL. Internal host address, container/VM ID and credentials are never returned to browser JavaScript.
6. A top bar shows workspace type, allocated GPU, session time remaining, connection state and Stop.
7. User files live under `/workspace`; export/snapshot is an explicit controlled operation.
8. End/expiry revokes the access grant first, stops runtime second, verifies cleanup third, and only then releases the machine.

## Access gateway

Interactive runtimes must not publish arbitrary host ports to the Internet. A gateway terminates TLS and validates a short-lived access grant bound to renter user ID, booking ID and session ID. Grants are random, one-session scoped, stored hashed, never logged, revocable and short lived.

The gateway routes only to the runtime selected by the server-side session. The renter cannot provide an arbitrary upstream host/port.

## Resource contract

A workspace session records an immutable allocation snapshot: accelerator ID, VRAM expectation, CPU, RAM, disk quota, runtime family, workspace manifest version, runtime image/template digest and network policy. The agent must execute that snapshot rather than accepting arbitrary shell/Docker arguments from the renter.

## Compatibility

The existing manifest compatibility engine remains the source for product eligibility. Runtime support adds another hard gate. For example, a machine can have enough RAM for Cloud Desktop but still be unavailable because it lacks the required virtualization/GPU isolation support.

A workspace must never be shown as runnable merely because its catalog card exists.

## Delivery order

1. Developer interactive beta — fastest path to a useful remote computer experience.
2. AI — reuse container engine, add NVIDIA runtime and JupyterLab.
3. Compute beyond diagnostic.
4. Cloud Desktop — first full graphical 'real PC' experience.
5. API and Data.
6. Creator, Video and CAD on the desktop VM engine.
7. Mobile.
8. Gaming and Audio after latency/streaming validation.
9. Security Lab only after the isolated VM boundary and network policy receive dedicated security review.

## Definition of done for Developer beta

From a second physical computer, a renter can reserve a compatible machine, wait for automatic preparation, click **Open workspace**, use VS Code in the browser, open a terminal, create/edit/run a small Python project in `/workspace`, observe the allocated remote GPU when applicable, export an allowed project artifact, end the rental, lose access immediately and observe the host return to `AVAILABLE` only after verified cleanup.

No manual action on the host PC is allowed during this acceptance test.
