# Rental Stop, Mining Control & Hot Presence v1

## Status

This layer is stacked on top of Agent Control Channel v1. It does **not** perform a production cutover by itself.

The objective is to move the first business-critical mutations onto the persistent regional control path without creating a second source of truth:

1. deliver the existing durable `MachineCommand` rows through the regional Gateway;
2. execute Developer `STOP_RENTAL` with exact, verified local cleanup;
3. qualify `START_MINING` / `STOP_MINING` transport and local execution in dark mode;
4. let the scheduler consume Gateway/Redis liveness in `shadow` and then a deterministic `hot` canary.

## Sources of truth

The control channel is transport, not business persistence.

- PostgreSQL `MachineCommand` remains the durable command source.
- Gateway Redis ACKs are a projection of Host terminal execution results.
- A command is not `ACKNOWLEDGED` in PostgreSQL merely because the Gateway accepted it.
- `SUCCEEDED` is required for PostgreSQL acknowledgement.
- For Developer `STOP_RENTAL`, the Delivery Worker first finalizes the server-owned `WorkspaceSession` idempotently and only then acknowledges the durable command.
- `FAILED` / `REJECTED` become terminal `DEAD` commands with a sanitized reason.
- If no terminal ACK is visible, the short DB lease expires and another worker checks Redis before redispatching.

This protects crash windows between dispatch, Host execution, terminal ACK, workspace finalization and durable-command completion. If the Host cleanup succeeded but the API process crashes before database finalization, a later worker reuses the existing Redis terminal ACK and retries only the idempotent database finalization; Docker is not re-executed.

## Deterministic rollout nesting

All new cutovers are disabled by default:

- `AGENT_CONTROL_CHANNEL_ROLLOUT_BPS=0`
- `MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS=0`
- `SCHEDULER_HOT_PRESENCE_ROLLOUT_BPS=0`
- `MACHINE_PRESENCE_MODE=legacy`

The direct-command and hot-presence cohorts reuse the Agent Control Channel bucket. Their rollout may never exceed the Agent QUIC rollout. Unsafe configuration is rejected rather than widening the cohort silently.

Recommended order:

`Agent QUIC dark -> command dark -> presence shadow -> 0.1% command -> 0.1% hot presence -> 1% -> 5% -> 25% -> 50% -> 100%`

Each dimension can be rolled back independently to zero.

## STOP_RENTAL invariant

The direct `STOP_RENTAL` path is intentionally limited to the **Developer Workspace** runtime because that is the runtime whose local resources can currently be reconstructed and verified exactly. Compute sessions and historical commands without a proven `workspaceSlug` remain outside this fast path.

The durable command carries the exact `WorkspaceSession.id` and `workspaceSlug`. Before Gateway dispatch, the API minimizes the Host payload to only:

- `sessionId`;
- `workspaceSlug=developer`;
- the bounded stop reason when present.

Renter ID, listing ID, booking ID, dates and other server-only fields are not forwarded to the Host.

The Agent derives all Docker resource names locally using the same canonical functions as `workspace_gateway.py`:

- workspace container `gpubnb-dev-*`;
- loopback proxy `gpubnb-dev-proxy-*`;
- workspace volume `gpubnb-workspace-*`;
- internal network `gpubnb-workspace-internal-*`.

The network never supplies a Docker name or shell expression. The Agent performs exact-name removal and returns `SUCCEEDED` only after container, proxy, volume and network are all confirmed absent.

`STOP_RENTAL` does **not** stop mining as a side effect. Rental cleanup and mining control are distinct mutations; coupling them would make a Developer stop capable of terminating another resource's miner.

After the Redis terminal ACK is observed, `finalizeVerifiedDeveloperStop` serializes finalization by session, transitions the active session to `COMPLETED` or `TIMED_OUT` using the existing workspace semantics, clears the gateway activation marker, conditionally restores machine operational state, and is idempotent for an already-terminal session. Only after that succeeds may the durable `MachineCommand` become `ACKNOWLEDGED`.

No global `docker prune`, wildcard cleanup, shell expansion or process-name guess is permitted.

## Mining control: dark qualification only

The protocol and Agent adapters understand `START_MINING` and `STOP_MINING`, but this layer intentionally does **not** expose a public owner start/stop API yet.

Reasons:

- the product model is per CPU/GPU resource;
- the current always-on Agent mining guard positively identifies GPUbnb miner executables, but its stop primitive is still machine-wide;
- exposing a per-resource remote stop on top of a machine-wide primitive could terminate another owner-approved mining resource;
- the API mining profile catalog and the pinned Host runtime catalog are not yet identical;
- managed-pool and owner-pool public prerequisites remain incomplete.

The direct executor therefore remains a dark capability for protocol/packaging qualification. Public mining command production is a separate gate after durable PID/resource fencing exists.

### Miner execution safety

Even in dark mode the Agent refuses arbitrary remote execution:

- no executable path from the network;
- no arbitrary argv from the network;
- only profile IDs whose binary hashes are pinned in the Host Rust manifest;
- executable must resolve directly under the approved miner root;
- SHA-256 must match the embedded release hash;
- only `stratum+tcp`, `stratum+ssl`, `stratum+tls` endpoints;
- credentials in URLs are rejected;
- raw/unresolved pool secret references are rejected;
- loopback, private, link-local, multicast, unspecified and reserved pool addresses are rejected;
- subprocess launch always uses `shell=false`.

A parity test locks the Python control adapter hashes to the Rust `approved_miner_manifest.rs` hashes.

## Scheduler hot presence

`MachinePresence` in Redis is used only as **connectivity authority** in this layer.

Business availability still belongs to listings, resource allocations, moderation and the authoritative phase state machine. A live `DRAINING` connection is therefore connectivity-positive; it does not independently make a machine rentable.

Modes:

- `legacy`: no Redis presence decision affects allocation;
- `shadow`: read/log presence but never block allocation;
- `hot`: only machines in the deterministic canary require live Gateway presence before resource allocation.

For assigned `hot` machines:

- missing/expired presence -> `machine_not_online`;
- Redis read failure -> fail closed as `machine_not_online`;
- `QUARANTINED` phase -> `machine_not_online`;
- live non-quarantined presence -> allocation continues through the existing PostgreSQL/advisory-lock path.

## Security boundaries

- Gateway admin endpoint is private service-to-service traffic protected by `x-gpubnb-internal-token`.
- Internal token is never returned in Agent assignment payloads.
- Direct command payload is minimized and bounded before dispatch.
- Durable command machine ID, command ID and sequence are preserved end-to-end.
- Redis terminal ACK identity must match machine ID and sequence before database completion.
- Terminal Host result is persisted locally before terminal network ACK by Agent Control Channel v1.
- A successful Host cleanup is not sufficient to complete a durable rental stop until the server-owned workspace finalization also succeeds.

## Next prerequisite for public mining control

Implement a resource-scoped miner supervisor with durable process identity:

- resource ID -> launch generation -> PID/process creation identity -> verified binary;
- safe recovery after reboot/crash without trusting a reused PID;
- independent CPU/GPU stop semantics;
- hardware-level lease/fence verification before start;
- signed runtime event projection after verified start/stop;
- profile catalog reconciliation and real NVIDIA/AMD qualification.

Until that exists, mining remote mutation rollout remains operationally dark.
