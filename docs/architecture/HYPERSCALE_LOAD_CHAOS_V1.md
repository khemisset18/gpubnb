# Hyperscale Load + Chaos Qualification v1

## Purpose

This layer turns million-machine scale from an architectural aspiration into a continuously checked engineering contract.

It deliberately separates two forms of evidence:

1. **Capacity modeling** for fleet-wide topology and failover assumptions.
2. **Live wire qualification** against the real Regional Control Gateway over QUIC, Redis and Ed25519 authentication.

A passing capacity model is not presented as proof that one process can serve one million machines. A passing live injector run is not extrapolated beyond the hardware and topology actually measured.

## Million-fleet capacity model

The checked profile in `config/hyperscale/million-fleet-v1.json` currently models:

- 1,000,000 connected machines;
- three active regions;
- 13 Regional Control Gateways per region;
- 50,000 hard connections per Gateway;
- normal target utilization <= 70%;
- one-region-failed utilization <= 80%;
- 15 second presence heartbeat interval;
- 120 second reconnect jitter after a regional loss;
- bounded reconnect, heartbeat-write and command-fanout rates per surviving Gateway.

The profile is a **planning envelope**. Values become production capacity claims only after equivalent live tests have been run on production-class hardware.

## N+1 regional failure model

For every profile the model calculates:

- total connection capacity;
- normal fleet utilization;
- remaining capacity after complete loss of one region;
- baseline heartbeat write rate;
- heartbeat write rate per Gateway;
- machines displaced by one failed region;
- deterministic reconnect distribution across the configured jitter window;
- peak reconnect rate per surviving Gateway;
- command fanout per Gateway.

Every limit is a hard gate. The command exits non-zero with `--require-pass` when a threshold is exceeded.

Reconnect distribution is seeded and deterministic. Incident reports can therefore reproduce the exact modeled storm instead of relying on a new random distribution on each CI run.

## Live QUIC injector

`gpubnb-hyperscale live` uses the production protocol implementation from the same Rust crate as the Gateway.

It does not fake an HTTP heartbeat. It performs the real sequence:

```text
load identity
  -> Ed25519 ClientHello
  -> QUIC + TLS + ALPN
  -> SERVER_HELLO
  -> Redis-fenced presence claim
  -> HEARTBEAT frames
```

The injector can run many copies horizontally. One injector is deliberately capped at 200,000 logical connections to avoid turning an operator typo into an unbounded local memory/socket event.

### Test identity isolation

Live mode requires the explicit `--allow-test-auth-write` switch before it writes any authentication records.

All generated identities use the namespace:

```text
load_machine_<12 digit id>
```

The injector only writes the corresponding `gpubnb:machine-auth:{load_machine_*}:v1` and presence keys. Test auth and presence keys are removed at the end unless `--keep-test-auth` is explicitly supplied for investigation.

The Ed25519 keys are deterministic test identities. They are never production Agent credentials and must never be copied into a production pairing database.

## Live scenarios

### steady

Maintains real QUIC connections for a bounded duration and sends real heartbeat frames. A configured sample of agents probes Redis until the expected presence sequence is visible, producing an end-to-end presence commit latency distribution.

Evidence includes:

- successful/failed connections;
- connection p50/p95/p99/max;
- heartbeat attempts/failures;
- sampled Redis presence commit p50/p95/p99/max;
- normalized failure classes.

### reconnect-storm

Repeatedly disconnects and reconnects every test Agent with deterministic jitter. Every cycle redoes TLS, QUIC, Ed25519 authentication, Redis presence claim and at least one heartbeat.

This is the live counterpart to the regional reconnect capacity model.

### replacement-fence

Opens two authenticated QUIC sessions for the same machine identity. The second session must replace the first, and the first must receive exactly one `FENCE(REPLACED_CONNECTION)` event.

This continuously checks the split-brain invariant under the real network protocol.

## CI chaos

The dedicated workflow starts an isolated Redis 7.4 instance and the actual release Control Gateway with a one-run TLS identity. It then executes:

1. Rust format and unit tests;
2. Clippy `-D warnings` on the load injector;
3. locked release build of Gateway + injector;
4. million-fleet N+1 model;
5. 128-agent live steady-state QUIC run;
6. 128-agent reconnect storm;
7. 32-machine duplicate-connection fencing run;
8. real Redis pause;
9. proof that `/readyz` fails closed while Redis is unavailable;
10. Redis resume;
11. proof that Gateway readiness recovers;
12. archive of JSON reports, Gateway logs and Prometheus metrics.

CI scale is intentionally small enough to remain repeatable on shared GitHub runners. Production capacity qualification is a separate controlled exercise using the same binary and report schema.

## What v1 does not claim

This PR does **not** claim:

- that one Gateway supports 50,000 connections on every instance type;
- that 39 Gateways are the final production fleet size;
- that a single injector can produce one million real QUIC sockets;
- that Redis or network saturation limits have been measured on production infrastructure;
- that a multi-region control plane has been chaos-tested across real cloud regions.

Those numbers require production-class distributed injectors and controlled regional fault drills.

## Exit criteria for a production-scale qualification

A production-scale run is accepted only when all of the following are archived for the exact release SHA:

- injector JSON reports from every shard;
- Gateway Prometheus snapshots per region;
- CPU, memory, network and file-descriptor utilization;
- Redis latency/CPU/memory/eviction metrics;
- connection and presence p50/p95/p99;
- reconnect storm p50/p95/p99 and error rate;
- proof that a failed region can be absorbed without exceeding the configured failover utilization ceiling;
- proof that stale/replaced connections remain fenced;
- proof that Redis unavailability fails readiness closed;
- exact hardware/VM/container/kernel/network configuration;
- release SHA and configuration hashes.

Only measured values from that evidence may be used as public capacity claims.
