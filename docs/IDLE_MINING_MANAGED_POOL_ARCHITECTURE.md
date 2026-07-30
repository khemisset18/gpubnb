# GPUbnb optional idle mining architecture

Status: development only. Rental remains the primary product. Mining is disabled by default and must never delay or weaken a rental.

## Product policy

The host owner chooses one of three modes per GPU:

1. Disabled: the GPU remains idle outside rentals.
2. GPUbnb managed pool: GPUbnb routes approved mining traffic and charges exactly 1% of the gross mining payout credited by the pool accounting layer.
3. Owner custom pool: the owner provides an approved Stratum endpoint and public wallet/worker settings. GPUbnb charges 0% and does not participate in pool payouts.

The owner can revoke consent at any time. A renter, administrator API call or remote control plane cannot silently enable mining.

## Non-custodial payment design

GPUbnb should not hold private wallet keys. For the managed mode, use a Stratum routing/accounting service that records accepted shares and splits attributable rewards:

- 99% owner entitlement
- 1% GPUbnb platform entitlement

Accounting must use integer atomic units and maintain the invariant:

`owner_amount + platform_amount = gross_amount`

Pool-side payout thresholds, network fees, stale shares and orphaned blocks must be visible separately. Never advertise guaranteed revenue.

## Rental-first state machine

A GPU can be in only one exclusive workload state:

- DISABLED
- IDLE
- MINING_STARTING
- MINING
- STOPPING_FOR_RENTAL
- CLEANUP_VERIFYING
- RENTAL_READY
- RENTAL_ACTIVE
- QUARANTINED

On reservation preparation:

1. stop accepting new mining work;
2. terminate the approved miner process tree;
3. verify process exit;
4. release GPU handles and temporary files;
5. wait for temperature and utilization to return below policy limits;
6. prove no miner process or container remains;
7. only then mark the GPU RENTAL_READY.

Any failed stop, cleanup, ownership check or thermal check places the GPU in QUARANTINED and blocks both mining and rental until local recovery succeeds.

## Controlled miner catalog

GPUbnb must not accept arbitrary executable paths, shell commands or miner arguments from users or the API. Every enabled profile is versioned and allow-listed with:

- asset and algorithm;
- GPU vendor compatibility;
- miner binary name and pinned version;
- download origin and SHA-256 digest;
- license and redistribution status;
- approved argument template;
- default thermal and power limits;
- supported Stratum schemes;
- rollback version.

Cryptocurrencies and miners change frequently. Profiles are therefore enabled individually after build, malware scan, license review and physical GPU testing. "All GPU-mineable coins" is a catalog goal, not a safe one-time implementation claim.

## Custom pool validation

Allow only explicit `stratum+tcp`, `stratum+ssl` or `stratum+tls` endpoints. Reject embedded credentials, query strings, fragments, whitespace, local addresses and blocked ports. Store pool passwords only as encrypted secret references. Redact wallets, credentials, authorization messages and full pool URLs from logs where appropriate.

Before starting, resolve DNS and protect against rebinding to loopback, link-local, private control-plane or cloud metadata addresses.

## Telemetry and safety

Collect per GPU:

- miner process identity;
- algorithm and profile version;
- accepted, rejected and stale shares;
- effective hashrate;
- temperature, hotspot temperature and fan speed when available;
- power draw and configured power limit;
- start/stop reason;
- last verified cleanup;
- reservation preemption latency.

Automatically stop and quarantine on sustained temperature breach, process identity mismatch, GPU ownership mismatch, watchdog timeout, repeated crashes or failed rental preemption.

## Services for managed pool mode

Recommended separately deployable components:

- Mining Catalog Service: signed profile and endpoint configuration.
- Stratum Gateway: TLS entrypoint, protocol normalization and upstream routing.
- Share Accounting Service: idempotent accepted-share ledger.
- Reward Reconciliation Worker: reconciles upstream pool credits and chain payouts.
- Settlement Ledger: immutable owner/platform accounting in atomic units.
- Payout Worker: executes configured payout policy without storing host private keys.
- Risk and Abuse Service: rate limits, detects proxy abuse and blocks unsupported destinations.

Do not operate a public managed pool until monitoring, DDoS protection, legal review, tax/accounting rules and payout reconciliation have been completed.

## API boundaries

Suggested owner-only resources:

- `GET /mining/catalog`
- `GET /machines/:machineId/gpus/:gpuId/mining-config`
- `PUT /machines/:machineId/gpus/:gpuId/mining-config`
- `POST /machines/:machineId/gpus/:gpuId/mining/stop`
- `GET /machines/:machineId/gpus/:gpuId/mining/status`
- `GET /mining/earnings`

Every mutation requires owner authorization, optimistic concurrency and audit logging. The Host agent receives a structured signed launch specification, never a raw command.

## Production gates

This feature remains NOT READY until all of the following are proven:

- Rust, API, web and agent tests pass;
- approved miner binaries are pinned, scanned and legally distributable;
- NVIDIA and AMD physical tests pass for every enabled profile;
- mining stops and cleanup completes before rental within a measured SLA;
- thermal and power protections are validated;
- custom-pool SSRF and secret-handling tests pass;
- managed accounting reconciles exactly with upstream pool data;
- 1%/99% settlement invariants pass under retries and partial payouts;
- legal, tax, sanctions and consumer disclosures are approved for launch jurisdictions.
