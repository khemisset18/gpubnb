# Stage 4 — private console gateway binding (candidate, NOT deployable)

**Status:** Software-only, feature disabled by default. No Render deployment, Windows
installation, publication, paid booking, remote streaming or signature changes.
This is a *stacked* change on PR #316, not a physical qualification.

## What is fixed

- The private API only marks newly created Windows-native qualification sessions
  with a `console-dedicated` backend when **all** of these are explicitly set:
  `BETA_TEST_DEV_BYPASS=true`, `ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET`,
  `GPUBNB_PRIVATE_CONSOLE_QUALIFICATION=true`, and a real 40-hex
  `GPUBNB_PRIVATE_CONSOLE_AGENT_COMMIT`.
- The marker lives in server-owned session resource limits, **not** browser input,
  listing metadata, mutable gateway registration data or a user-selectable URL.
  It is transmitted only by the authenticated Agent desired-session route.
- An Agent compiled from the **exact pinned SHA** also requires local
  `GPUBNB_PRIVATE_CONSOLE_QUALIFICATION=true`; it uses `--start-console`
  only for `cloud-desktop`, `WINDOWS_NATIVE` sessions authorized this way.
  Missing markers remain IddCx, invalid/stale markers reject, and a live backend
  change stops the stream. Default public and other workspaces do not change.

## This does NOT yet permit a 300-second physical test

**Do not enable the flags on Render or PC1 yet.** Additional work is mandatory:

1. The legacy IddCx heartbeat remains unchanged. The Agent now measures a
   **separate opt-in physical console proof**, transmits it inside the v2
   anti-replay signed heartbeat, and the private API checks GPU/NVENC/source
   release, measurement freshness and monotonic heartbeat counter before a
   short-lived Redis claim can authorize a private-only session. An invalid,
   absent, expired, unsigned or mismatched proof fails closed. **Do not set**
   `nativeDesktopStreamingAvailable=true` manually: the console source uses its
   own admission path.
2. This commit must be built as one exact-source signed four-component package
   with accepted publisher pin and rollback before installation. The older PC1
   package `f664a07...` and current Render `40e9ef5...` must not be mixed.
3. The Windows service now registers `SERVICE_ACCEPT_SESSIONCHANGE` and
   sets a process-wide console fence for every WTS transition. The gateway
   refuses new console media and stops usage/sessions on reconciliation. This
   is **defense in depth, not yet proof of immediate zero-leak revocation**:
   display topology change and authoritative worker-level media/input buffer
   revocation must still be physically measured and audited before enablement.
   Restarting the service is required to clear the WTS transition fence.
4. Confirm genuine monitor topology and exact NVIDIA UUID/LUID/NVENC H.264
   SPS/PPS+IDR on physical PC1, and stable browser WebCodecs rendering on PC2.
5. Perform the isolated 300-second continuously decoded **and rendered** frame
   campaign, keyboard/mouse witnessed effects, disconnect/lock/switch tests,
   STOP proof and allocation/billing cleanup. Failure means NO-GO.

Sources:
- https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change
- https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotificationex
- https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/
- `docs/operations/WINDOWS_NATIVE_STAGE4_CONSOLE_300S_RUNBOOK.md`

This change must remain a **draft PR** until independently reviewed and tested.
