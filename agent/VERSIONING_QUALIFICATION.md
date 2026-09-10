# Agent qualification version

For the private-beta Compute / `GPU_PROOF` qualification path, Agent `0.6.2` is the minimum qualified runtime.

The version boundary exists because earlier installers cannot be distinguished by source commit at heartbeat time and may predate runtime-behavior fixes that matter for a renter-billed job:

- `0.6.0`: may predate the pinned Compute image / pull-timeout and end-to-end GPU proof orchestration fixes.
- `0.6.1`: predates the exact-GPU-by-hardwareUuid fix. `gpu_proof_command()` used to hardcode `--gpus=device=0` for every GPU_PROOF job regardless of which accelerator the rental resource authority actually leased for the session - on a multi-GPU host this could attach the wrong physical GPU to a renter's paid job. No `0.6.1`-labeled Host installer was ever published, but the version still moved to keep it that way: an already-built local/test `0.6.1` binary must never be trusted as if it carried this fix.
- `0.6.3`: adds signed quarantine-diagnostic evidence for Host Docker runtime cleanliness. The API supplies the workspace session ids that are legitimately allowed to own GPUbnb containers/proxies/volumes/internal networks, and the agent reports only unexpected GPUbnb resources found by a read-only Docker inventory. Quarantine auto-clear requires this evidence; older agents can still execute the qualified 0.6.2 job protocol but must update before a diagnostic can prove runtime cleanup.
- `0.6.4`: hardens real Windows Host operation after physical qualification exposed heartbeat jitter and visible child consoles. Windows inventory subprocesses are hidden, static hardware probes and Docker capability discovery are cached away from the hot heartbeat path, and the corresponding API deployment uses a five-minute destructive offline grace.
- `0.6.5`: adds fencing-safe recovery of stale local `QUARANTINED` rental claims left by older sessions. Recovery requires a strictly newer server fence, the same physical GPU, no persisted process identity and a fresh quiescence proof; ambiguous state remains fail-closed. The surrounding quarantine flow also adds automatic local thermal rearm and server-side 98 C thermal quarantine/recovery orchestration.
- `0.6.6`: adds explicit Developer Workspace gateway protocol-v2 capability negotiation. The Host advertises support for a signed `ws_open` acknowledgement so the API can establish the real local code-server WebSocket before exposing the renter browser socket. This removes the beta.81 race where the browser could start VS Code's remote handshake while the upstream channel was still opening. The API keeps legacy protocol-v1 compatibility, and protocol-v2 billing activation remains tied to a real frame delivered to the authenticated browser rather than merely to preflight readiness.

The API therefore fails closed for job execution by requiring Agent `0.6.2` or newer. This keeps an older binary from appearing compatible and claiming a rental job it may not execute with the qualified runtime behavior.

Quarantine runtime-cleanliness qualification is deliberately a separate capability boundary: Agent `0.6.3` or newer is required to produce the `runtimeCleanup` proof used by the diagnostic system. This does not redefine the already-qualified job lease protocol minimum.

For the next Windows physical PC A ↔ PC B qualification after the 2026-09-10 beta.81 browser-handshake incident, use Agent `0.6.6` or newer so the run includes heartbeat hardening, fencing-safe stale-claim recovery and the latency-safe Developer Workspace browser-handshake protocol.
