# GPUbnb Windows Indirect Display Driver

This directory contains the GPUbnb-owned IddCx UMDF virtual-display driver.

The driver now contains the compiled implementation for one GPUbnb-owned monitor,
including:

- fixed mode creation (initial qualification target: 1920x1080 at 60 Hz);
- exact WTS session, generation, render-adapter LUID and display-nonce fencing;
- a monitor ContainerId deterministically derived from the GPUbnb display nonce;
- owner-handle binding for Plug/Unplug, with automatic monitor departure if the
  privileged control handle is cleaned up;
- a dedicated IddCx swap-chain processing thread;
- D3D11 device creation on the exact render-adapter LUID;
- strict swap-chain texture-dimension validation;
- correct IddCx frame completion/release sequencing.

This is still deliberately **not production-active**. Real monitor mutation is
guarded by the compile-time constant:

`GPUBNB_ENABLE_MONITOR_MUTATION = false`

CI must keep that gate false until physical qualification explicitly promotes a
signed build. The user-mode control plane also remains fail-closed unless it owns
an explicit RAII display lease. A successful build therefore proves ABI/build
compatibility, not runtime readiness or booking authority.

The swap-chain processor intentionally does **not** report graphical READY. It
currently drains and validates real IddCx surfaces only. READY requires the later
DXGI/virtual-display identity proof and a real hardware NVENC encode on the exact
leased GPU.

Pinned build baseline:

- x64
- WDK NuGet Microsoft.Windows.WDK.x64 10.0.26100.6584
- UMDF 2.25
- IddCx minimum behavior 1.4
- Windows 11 target (NT 10.0...22000 in the INF)

Security invariants:

- the control device ACL is SYSTEM-only;
- Administrators/Users/Everyone/Authenticated Users are not granted the control
  device handle;
- a monitor belongs to the exact handle that created it;
- another handle cannot unplug that monitor;
- closing/crashing the owner handle triggers the driver cleanup backstop;
- provider physical outputs are never valid capture targets;
- no driver build artifact is installable/promotable merely because CI built it.

Do not install or promote this driver from CI artifacts. Driver signing, physical
installation, virtual-display ownership, provider-desktop exclusion, DXGI capture,
NVENC, reconnect/failure handling and cleanup all require physical qualification.
