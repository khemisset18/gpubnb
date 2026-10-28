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


## Evidence review: browser, gateway, Render, and acceptance fit

### Browser client candidates

- The Apache Guacamole JavaScript client is Apache-2.0, but it does not speak RDP directly. Its documented architecture requires `guacd` plus an RDP/FreeRDP plugin to translate RDP into the Guacamole protocol. Guacamole 1.6 documents RDP Graphics Pipeline Extension support and a separate video stream mechanism. That makes it a possible browser display client, but the repository has no Guacamole endpoint and no evidence yet that the complete chain preserves the exact Windows NVIDIA hardware AVC encoder required by Stage 4. Treat NVIDIA/H.264 as unproven until the host and browser recorder identify the real encoder and bitstream.
- The small `grdpwasm` project demonstrates browser-to-RDP over a WebSocket-to-TCP proxy. Its README labels the client GPLv3 and says the sample proxy accepts any origin and sends RDP credentials from the browser to the proxy. It is not safe to adopt as-is; adapting it would require authentication, origin checks, session scoping, credential handling, dependency review, and maintenance/security review.

### Existing gateway boundary

At Stage 4 commit `40e9ef5`, the current Windows-native gateway is deliberately narrow:

- The renter first consumes a one-use workspace grant; the gateway then sets a Secure, HttpOnly, per-session cookie.
- Windows-native WebSocket upgrades are limited to `native-stream` with no query string.
- Browser-to-Agent messages are binary only and exactly 32 bytes (the GBNI input envelope); upstream native frames must be binary. The current route has per-channel lease authorization, expiry checks, bounded queues, backpressure handling, and close cleanup.
- Media uses the separate GBNM H.264 frame envelope.

Therefore RDP cannot reuse `native-stream` unchanged. It needs its own session-bound protocol and bounded byte tunnel, with the current one-use grant, cookie, lease guard, expiry/generation checks, queue budgets, audit redaction, and close/STOP cleanup carried over. Any browser-supplied RDP password, if unavoidable, must be memory-only and excluded from URLs, Redis keys, logs, and persisted rental/session records.

### Render and zero-euro constraint

The Stage 4 `render.yaml` at `40e9ef5` declares both the API web service and delivery worker as `free`. Current Render documentation says Free instances are supported for web services, Postgres, and Key Value; other service types do not support Free instances. The worker declaration is therefore not proof that the existing deployment runs at zero cost and needs account-side reconciliation before any deployment. Free web services cannot receive private-network traffic, can spin down after 15 minutes without inbound activity, share a 750-hour monthly allowance, and may be restarted. A new private `guacd` service cannot currently be assumed to fit 0 €. A public Free web service would also fail the private-only boundary unless placed behind the existing authenticated gateway and independently security-reviewed. Do not create or deploy a service until the route, quotas, and zero-cost condition are proven from the account's actual plan.

### Feasibility decision

RDP is a credible way to avoid GPUbnb's custom IddCx kernel-signing dependency, but it is **not yet a validated replacement** for the Stage 4 browser stream. The unavoidable gates are:

1. Read-only confirm PC1's Windows edition/build. Home cannot host inbound Remote Desktop.
2. Confirm the existing plan can provide an authenticated, isolated renter session without a new paid/private service or an exposed public RDP listener.
3. Prove the RDP host's actual display path uses NVIDIA hardware H.264; policy configuration alone is insufficient because the platform may fall back to software.
4. Prove remote session isolation from the provider console, then test keyboard/mouse mapping and teardown.
5. Resolve the existing generation-90 quarantine only through the repository's authorized signed recovery path. A quiet NVIDIA sample does not clear it.
6. Decide whether the test is qualifying the current GPUbnb Windows Native implementation or a separately named RDP backend. An RDP success cannot be reported as qualification of the custom IddCx/GBNM/GBNI path.

Until these gates pass, implementation should stay on this branch as a feasibility proposal. Do not change the main or qualification branch, add an unreviewed client dependency, alter PC1, or claim the RDP route meets the Stage 4 acceptance contract.

### Sources

- Microsoft, [Enable Remote Desktop on your PC](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remotepc/remote-desktop-allow-access): Windows Pro/Enterprise/Education host requirement; Home cannot host incoming RDP.
- Apache Guacamole, [client license](https://github.com/apache/guacamole-client/blob/master/LICENSE), [Implementation and architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html), [Configuring Guacamole](https://guacamole.apache.org/doc/gug/configuring-guacamole.html), and [Protocol reference](https://guacamole.apache.org/doc/gug/protocol-reference): Apache-2.0 terms, guacd/RDP translation, RDP GFX, and browser video streams.
- grdpwasm, [project README](https://github.com/nakagami/grdpwasm): GPLv3, sample browser/proxy architecture, and its stated origin/credential limitations.
- Render, [Deploy for Free](https://render.com/docs/free) and [Private Services](https://render.com/docs/private-services): Free service types and private-network restrictions.
