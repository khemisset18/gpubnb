# Windows Native RDP alternative: feasibility gate

Status: feasibility only, written 2026-10-28. This branch does not alter the default branch, PC1, Render, Secure Boot, certificates, local trust, or quarantine. No RDP service, account, firewall rule, policy, driver, or session was changed.

## Decision

A supported alternative to signing GPUbnb's own IddCx driver is to replace the custom virtual-display and media/input path with Windows Remote Desktop Services (RDP). Windows already supplies an indirect display adapter for remoting. Windows 11 21H2 and later exposes the H.264/AVC hardware-encoding policy for Pro, Enterprise, Education, and IoT Enterprise editions.

This avoids a GPUbnb driver package and its EV/Hardware Developer Center submission. It still depends on the built-in Microsoft Windows RDP stack. If the requirement means no Microsoft-supplied Windows component, that cannot be met on Windows 11 with Secure Boot while keeping the kernel trust policy intact.

## Why this is a real redesign

The current Stage 4 path has its own IddCx control ABI, browser media envelope (GBNM H.264 chunks), browser input envelope (GBNI), GPU-bound NVENC proof, and bounded lifecycle/cleanup protocol. RDP uses a different authenticated remote-session and graphics protocol. The current web client cannot consume an RDP byte stream as if it were a GBNM frame, and its keyboard/mouse reports are not RDP input PDUs.

The existing API gateway already relays authorized browser and Agent WebSocket traffic. Reuse is possible only after a separate, length-bounded RDP channel and browser RDP client are designed. Do not forward arbitrary TCP or accept RDP credentials in browser-visible URLs, logs, or reusable tokens.

## Security contract for any implementation

- Keep RDP private behind the existing authenticated Agent-to-gateway tunnel. Do not expose TCP 3389 to the public Internet.
- Require Network Level Authentication and authenticated TLS. Keep the default Windows code-integrity, Secure Boot, HVCI, and trust configuration unchanged.
- Use a dedicated non-administrator renter identity for each session. Never reuse the provider's account or credentials. Prove the renter cannot view or control the provider's desktop.
- Disable clipboard, drive, printer, audio, and device redirection unless separately qualified.
- Bind authorization to the exact machine, rental/session, GPU, generation, expiry, and one-use nonce. Retain the existing fail-closed quarantine and STOP/cleanup protocol.
- End the exact RDP session on STOP and prove the renter session, processes, display/capture resources, tunnel, and GPU work are gone before reporting cleanup.
- Never make a session bookable or clear quarantine from a successful RDP connection alone.

RDP session isolation is not by itself a sandbox. Application, file, process, network-egress, and provider-boundary controls need their own qualification.

## H.264 and NVIDIA proof

The Windows policy can request hardware H.264 encoding, but Microsoft's policy documentation says an error falls back to software encoding. A configured policy is therefore not evidence of NVIDIA NVENC. Qualification must identify the actual encoder on PC1 and fail closed on software fallback.

The acceptance campaign must retain the Stage 4 requirements: exact target GPU, browser-decoded advancing H.264 frames for 300 uninterrupted seconds with no gap above the existing limit, visible keyboard and mouse effects inside the renter session, reconnect, STOP, and complete cleanup. The existing continuity harness will need an RDP-aware frame source and must preserve its current safety bounds.

## Cost and service constraints

The route can avoid purchasing an EV certificate and avoids a Microsoft driver-signing submission only if the existing Windows edition and RDP host capability are sufficient. No new paid gateway, Render service, certificate, or license is included in this proposal. Cost remains unproven until the browser-to-Agent route is shown to fit current infrastructure and usage limits. If it needs paid capacity or an additional Windows/RDS license, the zero-euro condition fails and this branch must stop.

## PC1 gates before implementation or physical use

1. Read-only confirm Windows edition/build and that this edition can host the required RDP session.
2. Read-only inspect the effective RDP WDDM and AVC hardware-encoding policies. Do not change them in this feasibility phase.
3. Review the Windows 11 client-host session limit and provider-console behavior. The target is one isolated renter session; no concurrent multi-user claim is assumed.
4. Check whether an open-source browser RDP client can be pinned and integrated without sending reusable credentials to the browser.
5. Design isolated user provisioning, revocation, cleanup, and auditing before enabling RDP.
6. Keep generation-90 quarantine unchanged. The prior three-sample NVIDIA quiescence result is only an idle snapshot; it is not native cleanup authority. No NVENC physical test may use this quarantined GPU until the existing authorized recovery protocol succeeds.

## Branch implementation order

1. Add a separate RDP runtime backend contract. Keep the IddCx backend intact while the RDP path is experimental.
2. Add signed session authorization and a bounded RDP tunnel through the existing private WebSocket path. Reject unrecognized channel frames and stale session generations.
3. Integrate a browser RDP client and map its frame/decoder and input evidence into the existing qualification recorder.
4. Add tests for auth scope, replay, framing limits, backpressure, session teardown, and provider-session isolation.
5. Build a private, non-bookable package. Run software contract tests only.
6. After all code and PC1 security gates pass, arrange the existing zero-cost physical test. The 300-second test remains prohibited while quarantine or signing/cleanup gates are unresolved.

## Stop conditions

Stop the RDP path without changing PC1 if the Windows edition cannot host it, a dedicated renter identity cannot be safely created and revoked, provider-session isolation cannot be proven, hardware encoding falls back to software, private browser relay requires paid capacity, or the old generation-90 quarantine cannot be retired through signed evidence.

## Microsoft references

- [GPU paravirtualization and the built-in indirect display adapter for remoting](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/gpu-paravirtualization)
- [Windows 11 RDP H.264/AVC hardware-encoding policy](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-admx-terminalserver)
- [GPU acceleration for Azure Virtual Desktop](https://learn.microsoft.com/en-us/azure/virtual-desktop/enable-gpu-acceleration) (the encoder policy and fallback behavior; AVD's full deployment guidance is not assumed to apply to this host)
