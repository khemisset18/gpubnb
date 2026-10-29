# Stage 4: Windows 11 Home dedicated-console route (design and guarded groundwork)

Baseline: `40e9ef5991ab13753130121fd321c60c84b4a297`.
Status: **NOT IMPLEMENTED as a driverless streaming backend; NOT physically qualified; NOT BOOKABLE**.
This is a scoped Windows Native engineering branch. No installation, driver action,
signing, certificate/trust/pin change, deployment, forced quarantine recovery or
PC1/PC2 test is authorized. Do not treat this branch as a release artifact.

## Non-negotiable PC2 and host contract

- PC2 is **browser-only**: no Moonlight, Sunshine, browser plugin, driver, download
  or installation. Use the existing GPUbnb same-origin browser gateway and its
  bounded H.264/GBNM + 32-byte GBNI/WebCodecs transport; do not install a
  second streaming client.
- PC1 can be **Windows 11 Home** and may be a purpose-built, otherwise empty
  rental host. Home cannot host Microsoft's inbound Remote Desktop service.
  Do not patch TermService, bypass Secure Boot, use test-signing or install an
  unqualified IddCx/HID driver.
- One renter console session at a time, under a **distinct standard Windows user**
  with its own SID/profile. The provider signs out during the rental. An empty
  provider profile reduces exposure but is not a sandbox or authorization proof.
- Renters must not gain the host administrator token, stored GPUbnb credentials,
  service pipes, other Windows profiles, or other LAN hosts. Review least privilege,
  AppLocker policy feasibility on Windows 11 Home (KB5024351), firewall segmentation,
  and account creation/deletion separately, without configuring PC1 now.
- LocalSystem-only operations retain strict Authenticode, signed-worker policy,
  local-only protected named pipes, GPU UUID/LUID fences, no arbitrary execution,
  no wildcard media listener, replay fences and generation-90 quarantine.

## What the existing implementation already provides

- `native/windows-platform/src/session.rs`: WTS renter SID and console exclusivity
  proof, separate from provider SID. The helper must never auto-select the
  current console user.
- `native/windows-platform/src/process.rs`: creates the verified renter worker
  suspended in `winsta0\\default`, bound to the dedicated user's token.
- `native/windows-platform/src/input.rs`: typed scan-code/mouse SendInput, not an
  arbitrary remote command channel.
- `native/windows-media/Media.cpp`: **Windows.Graphics.Capture monitor capture**
  plus D3D11/NVIDIA NVENC (not generic DXGI Desktop Duplication). The current
  capture target is specifically an **IddCx nonce-bound monitor** and cannot
  automatically capture a physical display in a driverless mode.
- `agent/gpubnb_agent/workspace_gateway_v10.py`: authenticated loopback-only
  helper transport, fenced reconnect, usage and cleanup. PC2 already receives
  decoded frames in `apps/web/windows-native-desktop.js`; a separate WebRTC or
  Moonlight client is not required for the existing browser route.
- `apps/web/windows-native-continuity.js`: 300,000 ms of advancing
  decoded/rendered frames, max 3,000 ms between observations. Input effects
  require an independent physical witness.

## Code added in this branch: live-session safety hardening only

1. `ensure_active_console_renter` checks exactly one WTSActive interactive session,
   physical active console ID, and `WTSSessionInfoEx` **unlocked** flag (1).
   Unavailable/unknown/locked information rejects; no implicit RDP fallback.
2. Renter worker checks both its process session and the actual input desktop
   name `WinSta0\\Default` using `OpenInputDesktop`/UOI_NAME.
   Winlogon/UAC, ScreenSaver, disconnected, other session and failures reject.
3. Privileged service re-proves the **exact renter user SID** from a fresh
   WTS token, not just a session number that could be recycled, before releasing
   cached frames/input and after asynchronous frame reads. Worker rechecks after
   capture and before sending encoded frames and immediately before `SendInput`.
4. STATUS rechecks live console before emitting READY, avoiding usage reports
   solely because a previous media frame succeeded.
5. STOP and SUSPEND deliberately remain callable when the console is locked or
   transferred. Failure revokes the in-memory media capability and follows the
   existing fail-closed STOP/quarantine rules.

This hardening **does not** create a driverless monitor, a dedicated account, a
new backend enum, new deployable package, or any positive Stage 4 qualification.
It does not remove the original `virtualDisplay` requirement or authorize
software encoding or an unsafe provider-desktop fallback.

## Driverless media engine groundwork (added after the isolation guards)

The Windows Media DLL now exposes a **separate, non-default console capture ABI v3**:

- `GPUbnbConsoleMediaOpen` accepts an 80-byte explicitly versioned request:
  exact NVIDIA UUID/LUID, nonzero session nonce, expected WTS session ID,
  dimensions and frame timeout. Strictly rejects nonzero reserved words.
- `GPUbnbConsoleMediaReadFrame` returns a separate 64-byte ABI-v3 result and
  `GPUBNB_CONSOLE_PROOF_CONSOLE_DISPLAY` rather than the IddCx
  `GPUBNB_MEDIA_PROOF_DISPLAY_FOUND`. The older ABI-v2
  `GPUbnbMediaOpen`/`GPUbnbMediaReadFrame` remain unchanged and **reject
  console session handles**.
- Windows.Graphics.Capture `CreateForMonitor` selects one **and only one**
  active display path with a permitted physical connector (HDMI, DP, DVI,
  internal), targetAvailable, no forced target, fixed rotation, exact dimensions
  and refresh rate. No arbitrary primary monitor fallback. After choosing the
  monitor, the source GDI name and monitor path are retained and revalidated.
- The media call checks the worker's own Windows session, active console,
  WTSINFOEX unlocked state and input desktop `Default`. These are repeated
  after capture and after encoding, before encoded bytes are copied.
- The NVENC implementation is shared with the existing exact-GPU D3D11 engine,
  and its successful encoder output must still be established physically.
- `native/windows-platform/src/media.rs` now contains an independent typed
  Rust ABI-v3 loader and decoder that retains the existing DLL Authenticode
  signer verification. A console proof cannot be cast to the v2 IddCx type.

**Important:** this is an **unwired library capability**, not a running
GPUbnb rental backend. Worker command framing, helper lifetime, nonce binding,
signed release provenance, WTS notifications, per-frame browser revocation and
bookability are intentionally unchanged. The required product integration below
remains incomplete. An HDMI/DP connector alone is not evidence of a genuine
trusted physical screen; device identity needs further qualification.

## Required work before a driverless mode can exist

1. The separate console ABI exists but remains **unwired**. Build an explicit
   dedicated-console worker command and service runtime whose session nonce
   and source identity are bound to the authenticated rental generation. Do not
   use the IddCx `PrepareDisplay` command or re-label its proof fields. The
   display source must be proven to belong to the renter console and exact
   leased NVIDIA UUID -> LUID.
2. Ensure any app/monitor capture always runs as the renter, never as the
   privileged service or provider; validate the user/window-station/desktop
   source and abort on any ambiguous topology transition.
3. Make WTS lock/connect/disconnect/logon and display-topology notifications
   revoke the stream epoch and capability *before* any buffered frame or input
   can be served. A polling guard narrows the race but **does not prove absolute
   non-disclosure** during a simultaneous switch; event-triggered cancellation
   plus synchronized browser send and fault injection are mandatory.
4. Require fresh exact-GPU H.264 NVENC output, SPS/PPS + IDR, bounded GBNM
   frames, and a genuinely observed 300-second browser stream; reject software
   encoder and static/timer-only proof.
5. Require application/process/file/network isolation and cleanup after STOP,
   crash, reconnect, logoff, and reboot. Standard Windows users isolate profiles
   but do not provide VM-level containment.
6. Physical monitor/headless eligibility must be measured. Neither an unsigned
   virtual monitor, an unverified HDMI dummy nor an RDP host on Home is assumed.
7. Route the new backend through *separate* preflight/start/status/stop and
   schema-versioned evidence. Do not fabricate `virtualDisplay: true` or
   reuse IddCx-only `nvencReady` flags for a different capture engine. Preserve
   server booking, GPU fencing, cleanup/tombstones and quarantine.

## Test and release gate

Software tests should cover WTS active/locked/unknown/other-user conditions,
input desktop Winlogon/Default decisions, session-ID mismatches, STOP under
disconnection, no frame after revocation, incorrect GPU/monitor, stale epochs,
failing capture, token replay, cleanup and reconnect. Windows CI compilation
and unit tests are **software evidence only**; never claim PC1/PC2 success.

A permitted future physical campaign must separately prove: exact NVIDIA GPU
NVENC H.264 bitstream, at least 300 continuous seconds of browser-decoded and
rendered video with no >3 s frame gap, keyboard **and** mouse effects in the
renter account, zero provider desktop pixels, host isolation and verified cleanup.
Generation 90 quarantine remains unchanged until the existing authorized signed
recovery process completes. Windows bookability remains disabled.

## Primary references

- Microsoft WTS lock/unlock notification:
  https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change
- WTSINFOEX_LEVEL1 SessionFlags and UNKNOWN/LOCK/UNLOCK:
  https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w
- OpenInputDesktop / Default vs Winlogon desktop:
  https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop
  https://learn.microsoft.com/en-us/windows/win32/winstation/desktops
- Microsoft separate Windows user accounts:
  https://support.microsoft.com/en-us/windows/security/identity-signin/manage-user-accounts-in-windows
- Microsoft Windows 11 AppLocker edition checks (KB5024351):
  https://support.microsoft.com/en-us/servicing/os/windows/2023/02/kb5024351-removal-of-windows-edition-checks-for-applocker
