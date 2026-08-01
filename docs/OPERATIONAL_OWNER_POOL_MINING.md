# Operational owner-pool mining

## Product decision

GPUbnb will make personal-pool mining operational before considering any GPUbnb-managed pool.

For this phase:

- `OWNER_POOL` is the only mining mode targeted for real execution.
- Personal pools use the owner's usual pool, wallet and worker configuration.
- GPUbnb takes **0% commission** on personal pools.
- `GPUBNB_MANAGED` remains fully disabled and outside the operational scope.
- If the GPUbnb-managed pool is introduced later, its platform commission will be **1%**.
- Rental always has scheduling priority over mining.

## Core behavior

When a resource is idle and the owner has enabled mining, GPUbnb may start an approved local miner connected to the owner's pool.

When a paid rental is confirmed:

1. no new mining work is accepted;
2. the miner process for the rented resource is stopped;
3. process termination and resource release are verified;
4. the resource is quarantined if the stop cannot be verified;
5. the rental may start only after successful verification.

At the end of the rental:

1. the rental workspace is destroyed;
2. credentials, storage and network cleanup are verified;
3. resource health is checked;
4. mining resumes only if the owner enabled automatic resume.

## Operational milestone

The first implementation must use a controlled fake miner and prove this complete lifecycle:

1. owner-pool configuration;
2. approved binary verification;
3. process start;
4. runtime state becomes `MINING`;
5. paid rental preempts mining;
6. process stop is verified;
7. rental starts;
8. rental finishes and cleanup is verified;
9. mining resumes if authorized.

No real mining binary may be enabled by default before this lifecycle passes CI and physical-machine validation.

## Security requirements

- no shell execution;
- no executable path received from the API;
- no raw command-line arguments received from the API;
- local allowlisted profiles only;
- pinned SHA-256 for every approved binary;
- secrets stored through a supported secret store;
- logs must never expose wallet secrets or pool credentials;
- one supervised process per resource;
- fail-closed behavior on any integrity or stop-verification error.

## Future scope

A GPUbnb-managed pool may be reconsidered later with a fixed **1% platform commission**. It remains disabled, is not required for the first operational mining release, and must not delay the owner-pool runtime.
