# GPUbnb Windows Indirect Display Driver

This directory contains the GPUbnb-owned IddCx UMDF virtual-display driver.

The first milestone is intentionally fail-closed: the driver initializes one IddCx
adapter but does not report a monitor. This lets CI validate WDK/UMDF/INF
packaging before any physical machine can expose a new desktop surface.

Pinned build baseline:

- x64
- WDK NuGet Microsoft.Windows.WDK.x64 10.0.26100.6584
- UMDF 2.25
- IddCx 1.4 minimum behavior
- Windows 11 target (NT 10.0...22000 in the INF)

Do not install or promote this driver from CI artifacts. Driver signing, physical
installation, monitor ownership, provider-desktop exclusion, swapchain processing
and cleanup all require separate qualification.
