# Four desktop workspaces — isolated integration preview

Scope: Creator, Cloud Desktop, CAD and Gaming. This feature branch starts
from `main`, **not** from the unapproved native-Windows/WTS audit PR #333.
The four Linux Selkies-GStreamer workspaces use the already existing
Docker GatewaySupervisor and raw TCP/WebSocket proxy, **not** the Windows WTS
native four-component streaming installer. The paths are different.

## Activation policy

- Default: disabled in API and agent. Production: **always disabled**, even
  if `GPUBNB_DESKTOP_WORKSPACE_PREVIEW=true` is configured.
- API laboratory preview: set `NODE_ENV=test` or `development` and
  `GPUBNB_DESKTOP_WORKSPACE_PREVIEW=true` only in an isolated test environment.
- Agent laboratory preview: same two explicit environment values, on a
  qualified test Linux host only. Never configure these switches on PC1,
  Render, or an Internet-facing rental service.
- Machine-specific compatibility must still independently confirm
  `desktopGpuRenderingAvailable`, NVIDIA Toolkit, RAM, disk and VRAM. CUDA
  alone is insufficient. The agent must pin each local desktop image by digest
  and bind the exact booked hardware GPU UUID.
- Frontend must never open an unregistered or stale Gateway session; access
  grants remain authenticated, one-time, short-lived, and renter-scoped.
- **No** merge, Render deployment, PC1 command, quarantine change, or PC1→PC2
  streaming is authorized by this branch, CI, or the owner's visual inspection.

## Four acceptance paths (isolated)

For each slug: book a compatible GPU; wait for funded reservation; create
exactly one scoped workspace session; verify `WORKSPACE_PREPARE` for that slug;
check container/image digest and true GPU desktop rendering; register the
same loopback proxy; confirm status reports `canOpen` only with live Gateway,
healthy heartbeat, valid renter and booking; issue the scoped access grant;
confirm WebSocket video + input; stop; verify revoke, cleanup, release and
absence of cross-renter access. Exercise retry and concurrent double-click
races, expired/invalid sessions, wrong machine, GPU UUID mismatch,
revoked access and interruption of WebSocket streams.

## Unmet hardware/security gates

As documented in `docs/WORKSPACES_OVERVIEW.md`, the development WSL2
host lacks a real `/dev/dri/render*` node. Linux GPU rendering, physical
stream stability, image-hardening parity and production throughput are **not**
qualified. CI, unit tests and source inspection do not prove those gates.
Independent review of the exact final SHA is still outstanding.

Production release requires independent security review plus real Linux
desktop GPU/streaming proof, resource exclusivity, STOP/revocation/cleanup,
latency, and rollback qualification. No automatic switch from preview to
production exists.
