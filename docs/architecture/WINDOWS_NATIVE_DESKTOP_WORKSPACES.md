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

Until the Windows capability is persisted and physically qualified, the API must also reject these four slugs on Windows even if a malformed or stale inventory reports `desktopGpuRenderingAvailable=true`. That field is a Linux backend proof, never a Windows compatibility escape hatch.

## Windows-native runtimes

### Cloud Desktop

Launch an isolated GPUbnb renter desktop/session on Windows and stream only that session. Do not expose the provider's personal desktop. Workspace files live under a dedicated ACL-scoped renter directory.

### Creator

Launch a qualified native Blender build inside the renter session. GPUbnb must verify the renderer sees the exact leased GPU before marking the Workspace ready.

### CAD

Launch a qualified native FreeCAD build inside the renter session and require a real GPU-rendered viewport proof before readiness.

### Gaming

Launch Steam in the isolated renter session. The renter supplies their own Steam account and owned games. GPUbnb redistributes no games or account credentials. Gaming requires an explicit outbound-network policy distinct from the current network-isolated compute Workspaces.

### Native application trust

Automatic discovery for Blender, FreeCAD and Steam is restricted to explicit
Program Files paths. The Agent never resolves these renter-facing executables
through the process `PATH`, because a user-writable PATH entry must not be able
to replace a qualified Workspace application. Non-standard installations remain
fail-closed until GPUbnb has an explicit, signed application qualification policy.


## Streaming architecture

The Windows Host owns capture and encoding; Docker is not the GUI runtime.

Initial pipeline:

`dedicated renter session -> Windows GPU capture -> hardware encoder -> authenticated GPUbnb media session -> browser decoder`

The existing GPUbnb control plane remains authoritative for booking, fencing, reconnect grace, billing pause/resume and cleanup. Media transport is a data-plane concern and must not grant booking authority.

Cloud Desktop/Creator/CAD can tolerate a higher-latency first transport. Gaming must ultimately use a low-latency browser media transport; the existing control WebSocket may be used for signaling/control but should not be treated as the final high-performance game-video transport without measurement.

### Chosen Windows capture boundary

The initial implementation should use a GPUbnb-owned **virtual display** rather than capture a provider physical monitor. Windows IddCx is designed for indirect/virtual displays and remote-display scenarios, which makes it the preferred isolation boundary for Cloud Desktop and the shared graphical backend.

The media helper must therefore prove all of the following before reporting READY:

- a GPUbnb virtual monitor exists and belongs to the renter runtime;
- the capture source is that virtual monitor/output, never an arbitrary physical provider output;
- the Direct3D capture device is created on the adapter that owns the exact leased GPU;
- Desktop Duplication/DXGI can acquire a real frame from that output;
- the acquired GPU frame reaches NVENC on the exact leased GPU;
- the encoded frame is consumed through the loopback media endpoint;
- a desktop switch, display mode change, session disconnect or DXGI access-loss invalidates READY and forces capture re-creation/re-proof before billing may resume.

The helper protocol must identify the selected output/adapter strongly enough for the Agent to compare the start report with the preflight report. A bare `captureReady=true` is not sufficient for release qualification.

IddCx adds driver packaging/signing/deployment complexity. That complexity is preferable to silently streaming the provider's personal monitor. If the virtual-display driver is absent or cannot start, the Windows desktop backend remains unavailable.

## Windows service / renter worker boundary

The privileged Windows control service must not capture or inject input directly
into the provider's interactive desktop. It owns only privileged lifecycle tasks:
creating the renter boundary, applying ACLs, starting/stopping the worker, fencing
the leased GPU/session and verifying cleanup.

The graphical worker runs inside the dedicated renter logon session. The service
and worker communicate over local IPC with all of these requirements:

- a named pipe must use an explicit security descriptor; Windows default named-pipe
  ACLs are not acceptable for this authority boundary;
- the DACL is restricted to the GPUbnb service identity and the exact renter logon
  SID/session that owns the worker;
- remote pipe access is forbidden and the peer process/token is verified before
  accepting application-level messages;
- every handshake is fenced to the exact GPUbnb session id, GPU UUID, Workspace,
  monotonically increasing worker generation and Windows logon session;
- a stale worker from an earlier generation cannot resume or control a replacement
  session;
- the command surface is typed and finite (prepare display, start capture, suspend,
  resume only after fresh proof, stop); there is no arbitrary shell/command field;
- application choice remains the GPUbnb allowlisted Workspace policy rather than a
  renter-controlled executable path crossing the privileged IPC boundary;
- pipe disconnect, peer-token mismatch or worker crash immediately invalidates
  READY and media/billing eligibility until a fresh worker handshake and readiness
  proof complete.

The pure Rust lifecycle and worker-protocol modules are deliberately independent of
Win32 so these authority rules remain unit-testable on Windows and Linux. The
future platform layer must satisfy them; it may not bypass them.

## Isolation invariants

- Never capture or expose the provider's personal desktop.
- Dedicated renter identity/session and ACL-scoped workspace directory.
- Dedicated GPUbnb virtual display for the renter graphical surface; provider physical outputs are never valid capture targets.
- Exact leased GPU identity is checked before READY.
- No access to provider profile, browser cookies, documents, clipboard or mounted personal drives by default.
- Renter input is scoped to the dedicated session only.
- Process tree is owned by a GPUbnb job/session boundary and is terminated on cleanup.
- Reboot/reconnect follows the existing server-authoritative fencing and 10-minute reconnect/billing rules.
- Workspace-specific outbound networking is explicit; Gaming cannot inherit the no-internet policy by accident, and non-Gaming desktop Workspaces should stay fail-closed unless their manifest allows egress.
- Native media URLs are literal loopback IP endpoints with an explicit port; hostnames such as `localhost` are not trusted as a network boundary.

## Compatibility

The existing VRAM/RAM/disk requirements remain applicable. A Windows Host becomes bookable for one of these Workspaces only when both its normal manifest requirements and the Windows native-streaming preflight pass.

Examples from the current manifests:

- Cloud Desktop: 2 GiB VRAM minimum.
- Creator: 6 GiB VRAM minimum.
- CAD: 6 GiB VRAM minimum.
- Gaming: 8 GiB VRAM minimum.

These are minimum compatibility gates, not performance guarantees.

## Delivery order

1. Capability/preflight with a real virtual-display + capture + encode self-test; no catalogue enabling yet.
2. Authenticated Windows media session and dedicated renter-session lifecycle.
3. Cloud Desktop end-to-end.
4. Creator/Blender exact-GPU render proof.
5. CAD/FreeCAD viewport proof.
6. Gaming/Steam, audio, controller/input and explicit egress policy.
7. Reconnect, billing-pause, reboot and cleanup qualification, including DXGI/session-loss recovery.
8. Only then expose the Windows cards as `bookable`.

## Qualification boundary

Do not claim Windows support from unit tests alone. At least one physical Windows NVIDIA host with enough VRAM must prove virtual-display isolation, capture, hardware encode, browser decode, exact leased GPU use, provider-desktop exclusion, reconnect/billing behavior and cleanup before this backend can be promoted.
