# Windows-native desktop Workspaces

Status: design branch, not release-ready.

## Goal

Allow GPUbnb Hosts running Windows with a sufficiently capable GPU to offer Cloud Desktop, Creator, CAD and Gaming without requiring Linux or WSL2 desktop-GPU passthrough.

This is a second runtime backend. It does not replace the Linux/Selkies container backend introduced by PR #219 and it must not weaken its fail-closed compatibility rules.

## Why a separate Windows backend

The existing `desktopGpuRenderingAvailable` capability deliberately means the Linux container-rendering path is actually usable: real Linux, a real `/dev/dri/render*` node and NVIDIA Container Toolkit support. CUDA availability on Windows/WSL2 is not evidence that a Linux GUI container can render a desktop.

Windows therefore needs a different capability with a different proof. A powerful GPU alone is not sufficient.

## Proposed capability

Introduce a distinct server-facing capability such as `nativeDesktopStreamingAvailable` only after a real local preflight succeeds. The preflight must prove, rather than infer:

- native Windows interactive session available;
- supported GPU and driver visible by stable GPU identity;
- hardware video encode available for the selected GPU (NVENC for the first NVIDIA implementation);
- a real frame can be captured from a GPU-rendered test surface;
- that frame can be hardware-encoded and consumed by the local streaming endpoint;
- input injection/forwarding is available only inside the dedicated renter session;
- audio capture/playback path is available when the Workspace requires it.

The API must never derive this capability from CUDA, VRAM, GPU model name or Docker availability alone.

## Runtime selection

For the four graphical Workspaces the API chooses one qualified backend:

- Linux host with `desktopGpuRenderingAvailable=true` -> existing Selkies/container backend.
- Windows host with `nativeDesktopStreamingAvailable=true` -> Windows-native backend.
- Neither capability -> Workspace remains incompatible and non-bookable.

A host must never silently fall back from one backend to another after booking.

## Windows-native runtimes

### Cloud Desktop

Launch an isolated GPUbnb renter desktop/session on Windows and stream only that session. Do not expose the provider's personal desktop. Workspace files live under a dedicated ACL-scoped renter directory.

### Creator

Launch a qualified native Blender build inside the renter session. GPUbnb must verify the renderer sees the exact leased GPU before marking the Workspace ready.

### CAD

Launch a qualified native FreeCAD build inside the renter session and require a real GPU-rendered viewport proof before readiness.

### Gaming

Launch Steam in the isolated renter session. The renter supplies their own Steam account and owned games. GPUbnb redistributes no games or account credentials. Gaming requires an explicit outbound-network policy distinct from the current network-isolated compute Workspaces.

## Streaming architecture

The Windows Host owns capture and encoding; Docker is not the GUI runtime.

Initial pipeline:

`dedicated renter session -> Windows GPU capture -> hardware encoder -> authenticated GPUbnb media session -> browser decoder`

The existing GPUbnb control plane remains authoritative for booking, fencing, reconnect grace, billing pause/resume and cleanup. Media transport is a data-plane concern and must not grant booking authority.

Cloud Desktop/Creator/CAD can tolerate a higher-latency first transport. Gaming must ultimately use a low-latency browser media transport; the existing control WebSocket may be used for signaling/control but should not be treated as the final high-performance game-video transport without measurement.

## Isolation invariants

- Never capture or expose the provider's personal desktop.
- Dedicated renter identity/session and ACL-scoped workspace directory.
- Exact leased GPU identity is checked before READY.
- No access to provider profile, browser cookies, documents, clipboard or mounted personal drives by default.
- Renter input is scoped to the dedicated session only.
- Process tree is owned by a GPUbnb job/session boundary and is terminated on cleanup.
- Reboot/reconnect follows the existing server-authoritative fencing and 10-minute reconnect/billing rules.
- Workspace-specific outbound networking is explicit; Gaming cannot inherit the no-internet policy by accident, and non-Gaming desktop Workspaces should stay fail-closed unless their manifest allows egress.

## Compatibility

The existing VRAM/RAM/disk requirements remain applicable. A Windows Host becomes bookable for one of these Workspaces only when both its normal manifest requirements and the Windows native-streaming preflight pass.

Examples from the current manifests:

- Cloud Desktop: 2 GiB VRAM minimum.
- Creator: 6 GiB VRAM minimum.
- CAD: 6 GiB VRAM minimum.
- Gaming: 8 GiB VRAM minimum.

These are minimum compatibility gates, not performance guarantees.

## Delivery order

1. Capability/preflight with a real capture+encode self-test; no catalogue enabling yet.
2. Authenticated Windows media session and dedicated renter-session lifecycle.
3. Cloud Desktop end-to-end.
4. Creator/Blender exact-GPU render proof.
5. CAD/FreeCAD viewport proof.
6. Gaming/Steam, audio, controller/input and explicit egress policy.
7. Reconnect, billing-pause, reboot and cleanup qualification.
8. Only then expose the Windows cards as `bookable`.

## Qualification boundary

Do not claim Windows support from unit tests alone. At least one physical Windows NVIDIA host with enough VRAM must prove capture, hardware encode, browser decode, exact leased GPU use, isolation, reconnect/billing behavior and cleanup before this backend can be promoted.