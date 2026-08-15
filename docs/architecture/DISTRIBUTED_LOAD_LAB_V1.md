# Distributed Load Lab v1

## Purpose

This layer turns the single-runner hyperscale qualification introduced in the previous stack layer into an executable distributed qualification contract.

It is designed for a fleet that may reach millions of connected machines across multiple active regions. It does **not** claim that CI has measured one million live sockets. It defines how that measurement is partitioned, executed, aggregated, failed over and tied to an exact release.

## Evidence classes

GPUbnb keeps three evidence classes separate:

1. **capacity model** — whether topology and configured limits can theoretically carry the planned fleet and N+1 region failure;
2. **distributed live evidence** — measured QUIC, Redis presence and reconnect behavior from many injector shards;
3. **infrastructure evidence** — CPU, RSS, file descriptors, UDP errors, Redis latency, NIC saturation and fault timeline from the machines that ran the test.

A release claim must never substitute one class for another.

## Components

### `gpubnb-labctl`

The lab controller has two responsibilities.

`plan` validates a committed lab profile and materializes a deterministic execution manifest. The manifest contains:

- exact run id;
- exact fleet size;
- region allocation;
- injector shard ids;
- non-overlapping absolute machine-id ranges;
- deterministic shard seeds;
- N+1 capacity checks;
- reconnect budgets;
- ordered chaos stages;
- SLO envelope.

`aggregate` consumes the manifest plus one JSON report per expected shard. Missing, duplicated or identity-mismatched reports are release failures.

### `gpubnb-load-shard`

The shard runner opens real QUIC/TLS sessions against a real Regional Control Gateway.

Every generated machine identity is namespaced as:

```text
load_machine_<run-id>_<absolute-machine-index>
```

The tuple `(run-id, shard-id, machine-id-start, connections)` prevents two distributed injectors from accidentally authenticating as the same test machine.

Each shard performs the same signed Ed25519 ClientHello and bounded control framing used by the existing qualification path. Test machine credentials are generated deterministically from the shard seed and absolute machine index, written only to the explicit qualification Redis target, and removed after the shard unless `--keep-test-auth` is deliberately selected for a chaos drill.

## Million-fleet profile

`config/hyperscale/distributed-million-lab-v1.json` currently describes a planning envelope of:

- 1,000,000 machines;
- 40 injector shards;
- 25,000 connections per injector;
- 3 active regions;
- 13 Gateways per region;
- 50,000 configured maximum connections per Gateway;
- 14 injectors in `eu-west-1` and 13 in each other region;
- <=70% regional normal utilization;
- <=80% utilization after complete loss of any one region;
- <=400 modeled displaced reconnects/s per surviving Gateway.

The uneven 14/13/13 injector split is intentional: it gives exactly 40 bounded shards while preserving one million exact machine identities.

## Non-overlapping identity contract

The planner allocates absolute machine ranges sequentially. For every adjacent pair:

```text
previous.machineIdEnd + 1 == next.machineIdStart
```

The planner also requires:

```text
sum(shard.connections) == profile.fleetSize
```

A range overflow, duplicate region, invalid run id or fleet mismatch is rejected before any network load is launched.

## N+1 regional safety

The planner independently removes each region and evaluates:

- surviving total Gateway connection capacity;
- failover utilization;
- machines displaced from the failed region;
- reconnect rate after the configured jitter window;
- reconnect rate per surviving Gateway.

Every committed distributed profile must contain a region-loss stage for every configured active region. A profile that only tests the easiest region is invalid.

## Conservative evidence aggregation

The controller aggregates counts exactly:

- requested connections;
- successful/failed connections;
- heartbeat attempts/failures;
- sampled presence attempts/failures.

Percentiles are **not averaged across shards**. Without raw merged histograms, averaging p99 values would manufacture a statistically invalid global result.

v1 therefore uses the maximum shard p99 as a conservative release gate:

```text
conservativeGlobalP99 = max(shard.p99)
```

A future histogram protocol may provide mathematically merged fleet percentiles, but it must not weaken this rule by approximating from already-compressed percentiles.

## CI multi-region surrogate

The dedicated `distributed-load-lab` workflow starts:

- one Redis 7.4 instance;
- three release Control Gateway processes with unique Gateway ids and region ids;
- six concurrent real QUIC shard runners;
- two shards per region.

It validates:

1. the committed one-million planning manifest;
2. a small deterministic CI manifest;
3. six concurrent steady shards with unique machine ranges;
4. conservative aggregate steady SLOs;
5. six concurrent reconnect-storm shards;
6. conservative aggregate reconnect SLOs;
7. abrupt regional Gateway loss;
8. a stale presence record left by the killed Gateway;
9. reclamation of that same machine range by a surviving region.

The CI topology is a correctness surrogate on one host. It is not WAN latency, independent-zone failure, independent Redis-cluster failure or production hardware capacity evidence.

## Chaos stage contract

The profile supports the following stage types:

- `baseline`;
- `reconnect-storm`;
- `gateway-loss`;
- `region-loss`;
- `network-impairment`;
- `redis-outage`;
- `soak`.

Network impairment inputs are bounded in the profile contract. v1 rejects more than 20% configured packet loss or more than 2 seconds added latency from the generic planner because accidental destructive settings should not silently pass as ordinary qualification input.

## Resource SLO contract

The profile records release budgets for:

- Gateway CPU;
- Gateway RSS;
- Gateway open file descriptors;
- UDP error growth;
- Redis p99 latency;
- connection/heartbeat/presence failure rates;
- connect p99;
- presence p99.

The local CI workflow archives process and `/proc/net/snmp` snapshots. Production-class lab automation must collect these metrics continuously, not only at the end of a stage.

## Region-failure semantics

A regional control-plane failure must not invent durable business state. The expected transition is:

1. failed Gateway stops refreshing regional machine presence;
2. Agents reconnect with bounded jitter to a healthy region;
3. the healthy Gateway authenticates the machine identity again;
4. presence claim replaces the stale connection owner;
5. stale heartbeats cannot regain ownership because `connectionId` fencing remains authoritative;
6. durable booking/payment/lease authority remains in its existing transaction plane.

The distributed lab tests only control-plane identity and presence behavior. It does not move payment authority into the load system.

## Production deployment boundary

No load-lab command should be reachable from the public product API. No profile changes public rollout percentages. No production Agent private key is accepted as an injector credential.

Production-class qualification must run in a dedicated environment with explicit Redis, Gateway and injector inventory. The committed million profile is a target contract, not permission to point test identities at production infrastructure.

## Next evolution

After v1, the next capacity-proof layer should add:

- raw HDR-style latency histograms from every shard;
- signed run metadata and container digests;
- independent regional injector coordinators;
- continuously sampled CPU/RSS/FD/NIC/Redis telemetry;
- automated `tc netem` policies in dedicated hosts;
- sustained multi-hour soak qualification;
- controlled full-region route withdrawal;
- release attestation that binds all evidence to the exact Gateway image digest and configuration bundle.
