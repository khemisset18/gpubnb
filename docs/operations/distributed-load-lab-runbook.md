# Distributed Load Lab Runbook v1

## Objective

Use this runbook to execute a production-class, horizontally sharded Control Gateway qualification without confusing modeled scale with measured scale.

The committed million-fleet profile is a release target contract. A one-million-machine claim is valid only after the full distributed live run has been executed on recorded production-class infrastructure.

## Hard safety rules

- Use a dedicated qualification environment.
- Never point shard runners at the product's production Redis hot-state cluster.
- Never reuse production Agent private keys.
- Every run must use a unique lowercase `run-id`.
- Every injector must use exactly the shard id, machine-id start, connection count and seed from the generated manifest.
- Do not manually edit a generated manifest after `gpubnb-labctl plan`.
- Never disable TLS verification, Ed25519 authentication, presence connection fencing, backpressure or readiness checks to obtain a pass.
- Archive failed stages as evidence.
- Abort scale increases after an SLO breach; do not continue merely to reach a desired headline number.

## 1. Freeze the release under test

Record before launching load:

- Git SHA;
- Gateway container digest;
- injector container digest;
- Gateway configuration bundle hash;
- Redis version and topology;
- OS/kernel version;
- instance or bare-metal type;
- CPU count;
- RAM;
- file descriptor limit;
- UDP socket buffer settings;
- NIC speed;
- region and zone placement;
- load balancer/routing configuration;
- exact qualification profile SHA.

Any material change starts a new qualification run id.

## 2. Generate the immutable execution manifest

```bash
gpubnb-labctl plan \
  --profile config/hyperscale/distributed-million-lab-v1.json \
  --run-id release_2026_08_15_a \
  --output evidence/manifest.json \
  --require-pass
```

Do not continue if planning fails.

Check that the manifest states:

- exact fleet size;
- expected injector count;
- exact machine range for every shard;
- all region-loss checks passed;
- all reconnect-budget checks passed.

## 3. Provision injector hosts

Do not put one million sockets on one injector machine.

Start with the committed 25,000-connections-per-shard plan, then reduce the shard size if injector telemetry shows that the injector itself becomes the bottleneck.

Each injector host must have enough independent capacity for:

- UDP sockets;
- ephemeral ports;
- file descriptors;
- TLS/QUIC CPU;
- memory for connection state;
- NIC throughput;
- telemetry export.

A load generator at 100% CPU is not valid evidence of Gateway capacity.

## 4. Distribute shard assignments

For every entry in `manifest.shards`, launch exactly one shard runner with values copied from the manifest:

```bash
gpubnb-load-shard \
  --run-id "$RUN_ID" \
  --shard-id "$SHARD_ID" \
  --region "$REGION" \
  --machine-id-start "$MACHINE_ID_START" \
  --scenario steady \
  --gateway "$GATEWAY_ADDR" \
  --server-name "$TLS_SERVER_NAME" \
  --ca-cert "$CA_CERT" \
  --redis-url "$QUALIFICATION_REDIS" \
  --allow-test-auth-write \
  --connections "$CONNECTIONS" \
  --duration-seconds 900 \
  --heartbeat-ms 15000 \
  --ramp-ms 120000 \
  --presence-sample-every 256 \
  --seed "$SEED" \
  --max-connect-p99-ms 5000 \
  --max-presence-p99-ms 2000 \
  --max-failure-bps 100 \
  --output "evidence/shards/${SHARD_ID}.json" \
  --require-pass
```

The exact heartbeat/ramp values for a release must be recorded with the evidence. They may differ from this example only by an approved profile/runbook update.

## 5. Ramp measured fleet size progressively

Use controlled scale gates such as:

```text
10k -> 50k -> 100k -> 250k -> 500k -> 750k -> 1M
```

At each gate hold long enough to observe steady resource use.

Do not jump directly from CI-scale validation to one million live sockets.

## 6. Continuously collect infrastructure telemetry

Collect at least once every 10 seconds per Gateway and injector:

### Gateway

- CPU utilization;
- RSS;
- open file descriptors;
- Tokio/runtime saturation if exposed;
- active QUIC connections;
- connection accept/refusal rate;
- auth failures;
- heartbeat accepted/rejected counts;
- presence-store failures;
- command queue depth/backpressure;
- reconnect rate;
- UDP receive/send errors;
- packet drops;
- NIC bytes/packets.

### Redis

- command rate;
- p50/p95/p99 operation latency;
- CPU;
- memory;
- blocked clients;
- evictions;
- replication/failover state;
- network throughput.

### Injector

- CPU;
- RSS;
- open file descriptors;
- UDP errors;
- local socket count;
- NIC throughput;
- event-loop/runtime saturation.

If the injector hits its own resource ceiling first, invalidate that scale point and repartition.

## 7. Aggregate each stage

Place only shard JSON reports for one scenario in a dedicated directory and run:

```bash
gpubnb-labctl aggregate \
  --manifest evidence/manifest.json \
  --reports-dir evidence/shards/steady \
  --scenario steady \
  --output evidence/steady-aggregate.json \
  --require-pass
```

The aggregator fails when:

- a shard is missing;
- a shard id is duplicated;
- a report belongs to another run id;
- region/machine-range identity differs from the manifest;
- failure-rate SLOs are exceeded;
- conservative p99 gates are exceeded;
- any shard reports local failure.

## 8. Reconnect storm

Run the same manifest with `reconnect-storm` and the approved jitter window.

Required observations:

- no zero-delay thundering herd;
- successful signed reauthentication;
- presence reclaims are bounded;
- reconnect rate per Gateway remains below profile budget;
- error rate returns to baseline after the storm;
- Redis remains inside its approved latency budget.

## 9. Single Gateway loss

During active steady load:

1. select one Gateway instance;
2. record its active connection count;
3. terminate the process abruptly;
4. do not delete its Redis presence keys;
5. allow Agents to reconnect with normal jitter/routing;
6. verify a surviving Gateway replaces stale presence ownership;
7. verify no stale connection can subsequently refresh presence;
8. compare reconnect rate with the modeled budget.

A manual Redis cleanup invalidates the drill.

## 10. Complete region loss

Perform this only in dedicated staging/qualification infrastructure.

For each active region independently:

1. freeze the pre-fault fleet and resource snapshot;
2. withdraw that region from control-plane routing;
3. terminate or isolate all Regional Control Gateways in the target region;
4. preserve durable transaction-plane services unless the drill explicitly includes them;
5. observe displaced Agents reconnect to surviving regions;
6. verify total surviving utilization remains below the profile failover ceiling;
7. verify reconnect rate per surviving Gateway remains inside budget;
8. verify machine presence is owned only by the surviving connection;
9. verify booking/payment authority did not move into the regional hot-state layer;
10. restore the region and confirm traffic returns without duplicate ownership.

Repeat for every configured region. Testing only one region is insufficient.

## 11. Network impairment

Use a dedicated host/network namespace and record the exact impairment command.

Example categories:

- +25 ms latency;
- +50 ms latency;
- +100 ms latency;
- 0.1% packet loss;
- 0.5% packet loss;
- 1% packet loss;
- combined latency + loss.

The generic profile contract intentionally bounds impairment to <=20% packet loss and <=2 seconds added latency. More destructive experiments require a separately reviewed chaos plan.

Expected behavior:

- QUIC remains bounded;
- connection and heartbeat failures stay inside the stage's approved SLO or recover after fault removal;
- no permanent duplicate presence owner remains;
- no uncontrolled retry loop appears.

## 12. Redis outage/failover

Expected behavior during Redis unavailability:

- `/readyz` fails closed;
- new authenticated sessions requiring presence fail closed;
- no local process invents presence ownership;
- existing transaction-plane durable authority is unaffected;
- after Redis recovers, readiness returns without deleting state manually.

For a production-class Redis HA drill, fail the active Redis node/primary using the actual deployed topology rather than pausing a local container.

## 13. Soak

After chaos stages, run a multi-hour steady soak.

Release blockers include:

- RSS growth without plateau;
- file descriptor growth without plateau;
- rising UDP error counters;
- reconnect rate that does not return to baseline;
- Redis latency drift;
- stale test presence/auth records after cleanup;
- increasing log volume caused by expected normal disconnects.

## 14. Evidence bundle

Archive one immutable bundle containing:

```text
manifest.json
profile.json
release-metadata.json
steady-aggregate.json
reconnect-aggregate.json
shards/**/*.json
gateways/*/metrics.*
gateways/*/process.*
injectors/*/metrics.*
redis/*
chaos-timeline.json
network-policy.txt
logs/
```

Hash the final bundle and record the digest in the release qualification record.

## Release blockers

Do not approve a fleet-scale rollout when any of the following is true:

- distributed plan fails;
- a shard report is missing or mismatched;
- measured capacity is below the deployment target;
- Gateway or injector resource usage has no stable headroom;
- any region-loss drill exceeds 80% configured failover utilization;
- reconnect budget is exceeded;
- failure-rate or latency SLO is exceeded;
- stale connection ownership survives a replacement;
- Redis outage leaves `/readyz` healthy;
- recovery needs manual key deletion;
- the measured release cannot be tied to exact binaries/configuration;
- the one-million number exists only in the planning manifest and was never executed live.

## Reporting language

Every report must state separately:

- modeled fleet capacity;
- actual peak simultaneous live connections measured;
- sustained duration at that live peak;
- hardware and regions used;
- faults exercised;
- SLO results;
- evidence bundle digest.

Never report the modeled `fleetSize` as measured live capacity.
