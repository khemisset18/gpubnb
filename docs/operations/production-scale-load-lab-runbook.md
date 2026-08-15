# Production-Scale Load Lab Runbook v1

## Objective

Execute measured scale qualification progressively and produce evidence that can support a release-capacity claim without confusing a planning model with live capacity.

This runbook starts after #116 distributed correctness qualification is green.

## 1. Freeze the release

Create a release metadata JSON containing:

- exact Git SHA;
- Gateway image digest (`sha256:...`);
- injector image digest (`sha256:...`);
- configuration bundle SHA-256;
- Redis version/topology;
- OS/kernel and instance type;
- CPU, RAM, file-descriptor limit and NIC capacity;
- exact active regions.

Changing any of these fields requires a new run id.

## 2. Generate the production plan

First generate the immutable million-fleet distributed manifest with #116 tooling. Then derive the measured-scale ladder:

```bash
gpubnb-prod-labctl plan \
  --distributed-manifest evidence/distributed-manifest.json \
  --profile config/hyperscale/production-scale-ladder-v1.json \
  --release-metadata evidence/release-metadata.json \
  --run-id release_2026_08_15_a \
  --output evidence/production-plan.json \
  --require-pass
```

Do not manually edit `production-plan.json`.

## 3. Provision external lab infrastructure

Use dedicated qualification infrastructure. The repository does not assume a cloud provider.

Minimum requirements:

- at least three independently faultable regions;
- production-class Gateway nodes;
- isolated Redis HA topology;
- dedicated injector hosts;
- external metrics collection;
- ability to withdraw a region and impair network paths;
- enough injector hosts that load generation itself has headroom.

Never point the lab at production Redis or production Agent credentials.

## 4. Execute stages in order

The committed ladder is:

```text
live_10k
live_50k
live_100k
live_250k
live_500k
live_750k
live_1m
```

For each stage, launch exactly the `stage.shards` assignments from the production plan. A stage may use a partial final shard; use the exact `connections`, `machineIdStart`, region and seed emitted by the plan.

Do not start the next stage until the current stage has been qualified.

## 5. Continuous telemetry

Collect at least every 10 seconds.

### Gateway

- CPU;
- RSS;
- FD count and utilization against configured limit;
- active QUIC sessions;
- accepts/refusals;
- auth errors;
- heartbeat failures;
- Redis/presence failures;
- queue depth/backpressure;
- UDP errors/drops;
- NIC throughput.

### Injector

- CPU;
- RSS;
- FD count/utilization;
- socket count;
- UDP errors;
- NIC throughput;
- runtime/event-loop saturation.

### Redis

- p50/p95/p99 latency;
- CPU;
- memory;
- blocked clients;
- evictions;
- replication state;
- failover state;
- network throughput.

If an injector reaches its own ceiling first, invalidate the stage and repartition before retrying.

## 6. Produce stage evidence

For each stage create one `ProductionStageEvidence` JSON record containing the release identity, target, measured peak, sustained duration, shard counts, failure rates, p99 values, resource maxima, fault records and final evidence-bundle SHA-256.

The stage's immutable evidence bundle should contain at minimum:

```text
stage-evidence.json
shards/**/*.json
gateways/**/*.prom
gateways/**/*process*
injectors/**/*.prom
redis/**/*
chaos-timeline.json
network-impairment.txt
release-metadata.json
production-plan.json
logs/
```

Hash the final bundle and place the 64-hex digest into `evidenceBundleSha256`.

## 7. Gate each promotion

After a stage, run qualification only through that stage:

```bash
gpubnb-prod-labctl qualify \
  --plan evidence/production-plan.json \
  --evidence-dir evidence/stages \
  --through-stage live_250k \
  --output evidence/qualification-live_250k.json \
  --require-pass
```

A missing earlier stage fails promotion.

Do not continue after a failed gate until the cause is understood and a new clean stage evidence bundle is generated.

## 8. Gateway loss

During live load:

1. choose a Gateway with active sessions;
2. snapshot ownership and load;
3. terminate it abruptly;
4. preserve Redis presence;
5. let normal reconnect/fencing recover ownership;
6. verify the stale connection cannot refresh state;
7. verify no manual Redis deletion was needed.

Record `gateway-loss` fault evidence with `recovered=true` only when automatic recovery is proven.

## 9. Network impairment

Exercise controlled WAN conditions, for example:

- +25/+50/+100 ms latency;
- 0.1/0.5/1% packet loss;
- combined latency + loss.

Record exact commands/policies and start/end timestamps. Remove the impairment and prove recovery to baseline.

## 10. Redis HA failover

Use the real qualification Redis topology. Fail the current primary/leader using the topology's supported failover mechanism.

Required behavior:

- Gateway readiness fails closed when authoritative hot state is unavailable;
- no Gateway invents ownership;
- recovery occurs without manual deletion of presence keys;
- Redis latency and error rates return inside budget.

A paused single local Redis container is useful for CI but is not sufficient production-scale HA evidence.

## 11. Complete region loss

Repeat independently for every configured region:

1. freeze a pre-fault snapshot;
2. withdraw the target region from routing;
3. terminate/isolate all Gateways in that region;
4. preserve hot-state records;
5. observe displaced Agents reconnect to surviving regions;
6. verify unique ownership;
7. verify surviving capacity remains inside N+1 limits;
8. restore the region;
9. verify traffic returns without duplicate ownership.

Every region must have its own `region-loss` fault evidence record.

## 12. Soak

After the final scale and chaos drills, keep steady live load for at least the committed `minSoakSeconds` (4 hours in v1).

Block release on:

- monotonic RSS growth;
- FD growth without plateau;
- growing UDP errors;
- Redis latency drift;
- reconnect rate that does not return to baseline;
- stale auth/presence test data;
- expected disconnects causing unbounded log volume.

## 13. Final qualification

Run without `--through-stage`:

```bash
gpubnb-prod-labctl qualify \
  --plan evidence/production-plan.json \
  --evidence-dir evidence/stages \
  --output evidence/final-qualification.json \
  --require-pass
```

A release-scale claim requires `releaseReady=true`.

A measured one-million claim additionally requires `oneMillionMeasured=true`.

## CI contract evidence is not live scale evidence

The repository workflow uses synthetic, schema-valid evidence to prove that the qualifier accepts a complete valid bundle and rejects incomplete or under-target bundles. Those CI records test **qualification logic only**.

They must never be copied into a production evidence directory, used as input to a release claim, or reported as measured WAN capacity. A real capacity claim requires evidence generated by the external multi-region lab from the frozen release artifacts and real measured sockets/resources/faults described above.

## Hard release blockers

- any missing or duplicate stage evidence;
- release Git/image/config identity mismatch;
- measured peak below target;
- insufficient hold time;
- missing shards;
- protocol failure or p99 SLO breach;
- Gateway/injector/Redis resource ceiling breach;
- UDP error growth above budget;
- Redis evictions or blocked clients above budget;
- manual recovery during a required fault;
- duplicate ownership during a fault;
- any configured region not tested independently;
- soak below minimum;
- invalid evidence bundle SHA-256;
- final measured peak below one million while claiming one million.

## Reporting language

Always report separately:

- modeled fleet capacity;
- measured peak simultaneous live connections;
- sustained duration;
- release Git/image/config identity;
- hardware and regions;
- faults exercised;
- stage-by-stage SLO results;
- immutable evidence digests.

Never substitute the distributed plan's `fleetSize` for measured live connections.
