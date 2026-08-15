# Resource-Scoped GPU Supervisor v1

## Status

This layer is stacked on top of Rental/Mining Presence v1 (#112). It does **not** enable public remote mining or widen any production rollout by itself.

The goal is to remove the last machine-wide process ownership assumption from direct mining control so one physical GPU can transition independently between mining and rental without terminating work on another GPU in the same host.

## Authority model

The always-running GPUbnb Agent is the process authority for direct mining mutations.

- The desktop application remains owner UX/configuration and may keep its existing local orchestration for compatibility.
- The regional control channel transports commands; it is not process ownership.
- PostgreSQL owns durable business configuration/audit/history.
- Redis `ResourceLease` owns distributed resource fencing.
- The Agent owns local OS process identity and recovery.

No public owner start/stop route is enabled in this layer. The production Delivery Worker from #112 still refuses mining mutation.

## Stable GPU identity

A slot index is observation metadata, not identity. Driver, BIOS or PCI enumeration changes must not move a mining configuration to another GPU.

The identity chain is:

`MiningResource.id -> Accelerator.hardwareUuid -> local GPU UUID -> PCI BUS:SLOT -> miner device selector`

`MiningResource.resourceKey` for GPUs is now based on the stable hardware UUID. Existing resources are migrated in-place through the unique `acceleratorId`, preserving their primary key, configuration, runtime events and audit history.

For the v1 execution adapter, NVIDIA UUID -> PCI mapping is resolved locally from `nvidia-smi`. The network never supplies a PCI slot or miner device index.

## Resource fence = runtime generation

GPUbnb already has a monotonic Redis fencing token per `resourceId`. v1 deliberately reuses that token as the local runtime generation rather than inventing a second counter.

For every direct mining mutation:

1. the regional Gateway requires a resource lease;
2. the Gateway checks that lease against Redis;
3. the command carries the exact `resourceId` and `fencingToken`;
4. `runtimeGeneration` is the same decimal string as `fencingToken`;
5. the Agent compares both strings exactly before converting the value to a Python integer;
6. stale/future/replayed generations are rejected by the local resource supervisor.

The generation is never serialized as a JavaScript `Number`; Redis fencing tokens are valid up to signed 64-bit range and can exceed IEEE-754 safe integer precision.

## Local process identity

A PID alone is never authority.

A running GPUbnb miner is owned only when all of these match the persisted runtime record:

- `resourceId`;
- stable GPU hardware UUID;
- runtime generation/fence;
- PID;
- OS process creation identity;
- canonical executable path under the approved miner root;
- pinned binary SHA-256 recorded at launch.

On Windows, the Agent reads process `CreationDate` and `ExecutablePath` through `Win32_Process`. On Linux test/runtime compatibility, it uses `/proc/<pid>/stat` start time plus `/proc/<pid>/exe`.

If a PID has been reused by another process, the resource is quarantined and GPUbnb does **not** terminate it.

## Durable local journal

The Agent persists one record per mining resource in `gpu-resource-runtime-v1.json` using atomic replace semantics.

States in v1:

- `MINING`
- `STOPPED`
- `QUARANTINED`

On Agent startup, reconciliation runs before the control channel accepts a direct mutation:

- exact persisted process identity still alive -> adopt as `MINING`;
- recorded process absent -> mark `STOPPED`;
- PID/path/creation identity mismatch -> `QUARANTINED`;
- incomplete mining identity -> `QUARANTINED`.

Recovery never kills an unverified process.

## Independent GPU execution

A resource start resolves the target GPU locally from hardware UUID and constructs a miner selector for that one GPU. Another resource with a different hardware UUID can remain mining while the first is stopped.

The supervisor rejects:

- two live resource records claiming the same hardware UUID;
- stale generation stop/start;
- same-generation restart after the original runtime is gone;
- hardware UUID changes for an existing resource;
- unverified executable provenance;
- unverified process identity;
- missing or mismatched resource lease/fence.

The initial implementation serializes mutations inside one Agent for conservative correctness. This does not couple ownership: each resource still has an independent durable record and process. Per-resource lock striping can be added after hardware soak without changing the external protocol.

## Miner/runtime qualification

The server, desktop catalog and pinned runtime manifest are aligned. A profile may be production-enabled only when the corresponding executable provenance is pinned and an execution adapter exists.

Resource-scoped GPU v1 intentionally qualifies only the NVIDIA + lolMiner path. Unsupported vendors/profiles fail closed. AMD resource-scoped mutation stays disabled until an equivalent stable device-selector path is verified on real hardware.

The older machine-wide Agent mining helpers remain only for compatibility/tests; direct QUIC mining no longer uses them.

## Rental interaction

This PR does not weaken the rental safety barrier. Developer Workspace preparation continues to use the existing fail-closed mining exclusion path until resource-scoped rental allocation is wired end-to-end.

Before public mining rollout, hardware qualification must additionally prove:

- the selected miner actually opens only the target GPU;
- stopping it releases the target GPU/VRAM before rental start;
- another GPU's mining process survives the transition;
- reboot, Agent crash and PID reuse do not cross resource boundaries.

## Rollout

No production mining cutover is performed here.

Safe defaults from the stacked layers remain unchanged:

- `AGENT_CONTROL_CHANNEL_ROLLOUT_BPS=0`
- `MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS=0`
- `SCHEDULER_HOT_PRESENCE_ROLLOUT_BPS=0`
- `MACHINE_PRESENCE_MODE=legacy`

Mining command production remains blocked until resource-scoped hardware qualification and an explicit canary PR.
