# Resource-Scoped GPU Rental Preemption v1

## Goal

A machine may continue mining on unallocated GPUs while a rental takes exclusive ownership of only its allocated GPU resources.

For a two-GPU host, the intended transition is:

```text
GPU A: MINING -> PREEMPTING -> QUIESCENT -> RENTAL_ACTIVE -> CLEANUP -> STOPPED
GPU B: MINING ---------------------------------------------------------> MINING
```

This layer stacks on `RESOURCE_GPU_SUPERVISOR_V1.md`. It does not enable public mining dispatch or change existing rollout defaults.

## Authority chain

Rental ownership is derived server-side from live booking allocations. The Agent never chooses which GPU belongs to a reservation.

```text
Booking
  -> AcceleratorAllocation / MachineAllocation
  -> Accelerator.hardwareUuid
  -> MiningResource.id
  -> priority ResourceLease
  -> fencingToken
  -> signed Agent rental authority
  -> local GPU UUID
  -> Docker DeviceRequest
```

For selected-accelerator listings only live `HELD`, `CONFIRMED`, or `ACTIVE` accelerator allocations are authoritative. For a full-machine allocation all qualified machine GPUs are included.

## One fence

A rental does not introduce a second generation counter. The same Redis resource-fence counter used by mining is incremented when the server derives an active rental. A rental priority lease therefore supersedes an older mining lease for the same `MiningResource`.

The first authority refresh for a reservation increments the fence. Later refreshes by the same session/resource pair renew the same lease idempotently without incrementing the fence again.

The Agent copies the rental fencing token into the local GPU runtime generation when mining has been stopped. Old mining commands are therefore stale locally even if they are replayed after the network reconnects.

## Process ownership before preemption

The Agent never stops a process because its executable name matches a miner. A mining process is preemptible only when all persisted ownership fields still match the live process:

- PID;
- OS process creation identity;
- canonical approved executable path;
- resource id;
- GPU hardware UUID;
- previous runtime generation.

PID reuse or any identity mismatch quarantines the target resource and no unknown process is terminated.

## Target-GPU quiescence proof

After the owned miner exits, the Agent resolves the target NVIDIA UUID and requires three consecutive samples that satisfy all of the following:

- the sampled UUID exactly matches the allocated hardware UUID;
- no NVIDIA compute process is reported for that UUID;
- GPU utilization is at most 5 percent;
- used framebuffer memory is below the bounded idle threshold;
- the same checks remain true across consecutive samples.

The compute-process query is filtered by GPU UUID. Activity on an unallocated GPU therefore does not invalidate the target GPU proof.

A failed proof quarantines the target resource and prevents workspace launch.

## Docker isolation

The legacy Developer Workspace runtime used `--gpus=device=0`, which cannot safely represent a resource-scoped allocation after PCI/index reorder.

v5 passes the exact allocated NVIDIA UUID set to Docker:

```text
--gpus device=GPU-<uuid>[,GPU-<uuid>...]
```

Before an existing workspace is adopted after an Agent restart, Docker `HostConfig.DeviceRequests` must contain exactly the expected UUID set and the persisted rental claims must be `RENTAL_ACTIVE`. Ambiguous or mismatched containers are destroyed and rebuilt only after a new quiescence proof.

## Cleanup and resume

On stop, the workspace container, proxy, storage and internal network are removed first. The Agent then proves each rental GPU quiescent again. Only after that proof are local rental claims removed.

The Agent sends the exact rental lease identities back to the signed API release route. The API releases them only when the workspace has stop intent or has expired. If the release request fails, safety is preserved because the server-side rental lease remains fenced until TTL expiry.

A new mining command is also blocked locally while any rental claim remains for that resource.

## Compatibility and rollout

`workspace_gateway_v5` is installed after the v2/v3/v4 transport/security stack. It changes GPU ownership hooks only.

During a staggered deployment, if the new signed rental-authority endpoint is unavailable, v5 does not infer resource ownership. It falls back to the already-qualified legacy machine-wide mining guard. Once the endpoint is available, a live Developer Workspace session without a valid resource authority fails closed.

v1 directly qualifies NVIDIA GPU resources only. Unsupported direct vendor paths remain fail-closed until equivalent stable device identity, passthrough and quiescence semantics are hardware-qualified.
