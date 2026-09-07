# Host runtime cleanliness diagnostic

## Purpose

A machine must not leave quarantine only because PostgreSQL bookkeeping looks clean. A renter runtime can survive locally after an agent/process failure as a Docker container, loopback proxy, per-session volume or internal network. The quarantine diagnostic therefore requires a read-only proof of the Host's actual GPUbnb Docker state.

This proof is diagnostic evidence only. It never performs cleanup by itself.

## Authority model

The API is authoritative for which workspace sessions are allowed to have local runtime resources. When a quarantined Host polls `/agent/diagnostics/next/:machineId`, the API returns `expectedRuntimeSessionIds` for non-terminal sessions in `PREPARING`, `READY`, `RUNNING`, `STOP_REQUESTED` or `STOPPING`.

Agent 0.6.3 derives the expected Docker names locally using the same canonical helpers used by the production workspace gateway:

- workspace container: `gpubnb-dev-<session suffix>`;
- loopback proxy: `gpubnb-dev-proxy-<session suffix>`;
- workspace volume: `gpubnb-workspace-<session suffix>`;
- per-session internal network: `gpubnb-workspace-internal-<session suffix>`.

The shared `gpubnb-workspace-gateway` network is infrastructure and is intentionally excluded from orphan detection.

## Read-only Host inspection

`agent/gpubnb_agent/runtime_cleanliness.py` executes only inventory commands:

```text
docker ps -a --format {{.Names}}
docker volume ls --format {{.Name}}
docker network ls --format {{.Name}}
```

It filters to GPUbnb-owned prefixes and compares them with the canonical resources allowed by `expectedRuntimeSessionIds`. It does not call `docker rm`, `docker volume rm`, `docker network rm`, prune, stop or kill.

The signed diagnostic result contains bounded evidence arrays only:

- `unexpectedContainers`;
- `unexpectedVolumes`;
- `unexpectedNetworks`.

The agent does not send a trusted `clean` boolean. The API derives PASS/FAIL from the evidence itself.

## Quarantine rule

`runtimeCleanup` is a mandatory diagnostic check.

- evidence present and all three arrays empty → `PASS`;
- one or more unexpected GPUbnb resources → `FAIL`, mapped to `WORKSPACE_CLEANUP_FAILED`;
- evidence absent → `UNKNOWN`, which is also blocking;
- Docker inventory command failure → the diagnostic execution fails and quarantine remains.

This means an Agent older than 0.6.3 cannot accidentally auto-clear quarantine after the server begins requiring runtime-cleanliness evidence. It must be updated and the diagnostic rerun.

## Rolling deployment compatibility

A 0.6.3 agent talking temporarily to an older API does not run the new Docker inspection unless the assignment explicitly contains `expectedRuntimeSessionIds`. This keeps agent-first rolling deployments compatible.

The opposite direction is intentionally fail-closed: a new API receiving a result from an older agent gets no runtime-cleanliness evidence, so `runtimeCleanup` is not PASS and quarantine is not lifted.

## Cleanup and repair

The production workspace gateway already owns active reconciliation and `_sweep_orphaned_containers()` cleanup. The quarantine diagnostic does not duplicate that mutating authority.

If runtimeCleanup fails:

1. keep the machine quarantined;
2. allow the normal gateway reconciliation to clean stale per-session resources where possible;
3. restart/update the Host agent if necessary;
4. rerun the diagnostic;
5. only a new clean proof can permit quarantine exit.

Automatic remote process cleanup remains a separate feature. It should use the authenticated Machine Command Gateway only after that control channel's rollout is explicitly enabled and qualified. The diagnostic must remain safe and read-only regardless of that future capability.

## Security invariants

- The browser never supplies runtime-cleanliness evidence.
- The assignment and result use the existing authenticated agent request channel.
- The API decides which session ids are legitimate.
- The API calculates PASS/FAIL rather than trusting a client boolean.
- Evidence is bounded to 64 names per resource class and 200 characters per name.
- Only GPUbnb-owned resource prefixes are considered; unrelated Docker workloads on the Host are ignored.
- Missing evidence never means PASS.
