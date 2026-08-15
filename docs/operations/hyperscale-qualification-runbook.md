# Hyperscale Qualification Runbook v1

## Scope

Use this runbook to qualify Control Gateway capacity and failure behavior. Do not convert modeled capacity into a production claim without a live run on production-class infrastructure.

## Safety rules

- Never point the injector at production Redis unless the environment is explicitly dedicated to qualification.
- Never reuse a production Agent private key.
- Keep test machine ids in the `load_machine_*` namespace.
- Keep public rollout percentages unchanged during qualification.
- Do not disable fencing, authentication, presence ownership, backpressure, or readiness checks to make a test pass.
- Archive failed reports as well as successful reports.

## CI qualification

The GitHub workflow `hyperscale-qualification` is the minimum regression gate. It must remain green before merging changes that touch the Control Gateway qualification path.

Expected CI evidence:

- `model.json`
- `live-steady.json`
- `live-reconnect.json`
- `live-fence.json`
- `gateway-metrics.prom`
- `gateway.log`

The workflow also pauses Redis and proves that Gateway readiness fails closed and recovers after Redis resumes.

## Production-class load qualification

### 1. Freeze the release

Record:

- Git commit SHA;
- container digest;
- Gateway configuration;
- Redis version/topology;
- kernel and QUIC/network settings;
- VM/instance type;
- NIC bandwidth;
- region and zone placement.

Do not change these during a comparison run.

### 2. Run the capacity model

```bash
services/control-gateway/target/release/gpubnb-hyperscale model \
  --profile config/hyperscale/million-fleet-v1.json \
  --output evidence/model.json \
  --require-pass
```

A failure here is a topology/configuration failure. Adding more load injectors does not fix an underprovisioned N+1 plan.

### 3. Baseline one Gateway

Start below 10% of the intended connection ceiling. Increase in controlled steps such as:

```text
5% -> 10% -> 20% -> 40% -> 60% -> 70%
```

At every step archive:

- connect success/error rate;
- connection latency p50/p95/p99;
- sampled presence commit p50/p95/p99;
- Gateway CPU/RSS;
- event-loop/runtime saturation indicators;
- UDP packet loss/errors;
- open file descriptors;
- Redis operation latency and CPU;
- Gateway backpressure counters.

Stop increasing load when any SLO is breached. The last stable step, not the configured maximum, is the measured capacity of that hardware/configuration.

### 4. Reconnect storm

Use multiple injector shards and a jitter window matching the capacity profile.

The test must include:

- authenticated reconnects;
- Redis presence replacement;
- heartbeats after reconnect;
- no uncontrolled synchronized retry burst;
- no stale presence ownership after replacement.

Compare observed reconnect rate per Gateway to the modeled budget.

### 5. Split-brain replacement

Run `replacement-fence` against a representative subset. Every duplicate authenticated connection must cause the previous socket to be fenced.

Any missing fence is release-blocking.

## Chaos drills

### Redis unavailable

Expected behavior:

- `/healthz` may continue proving that the process exists;
- `/readyz` must fail;
- new authenticated sessions that require Redis must fail closed;
- no stale lease/presence assumption may be invented locally;
- readiness must recover after Redis is healthy.

### Gateway process loss

Kill a Gateway instance while a reconnect-storm injector is running.

Expected behavior:

- clients reconnect with jitter rather than a synchronized zero-delay loop;
- another healthy Gateway can accept the displaced population;
- replaced/stale connections do not regain presence ownership;
- no command is acknowledged by two concurrent connection owners.

### One regional control-plane loss

Remove an entire region from routing in a dedicated staging/qualification environment.

Expected behavior:

- surviving regions remain below the profile's failover utilization ceiling;
- reconnect rate per surviving Gateway stays inside budget;
- durable booking/payment state remains authoritative;
- active renter data plane is not needlessly terminated by a control-plane routing event.

### Packet loss and latency

Inject bounded packet loss and latency between injector and Gateway in a dedicated environment. Record the exact traffic-control policy used.

Expected behavior:

- QUIC reconnect/recovery remains bounded;
- heartbeat timeout does not create permanent duplicate ownership;
- reconnect jitter limits thundering-herd behavior;
- error rates return to baseline after fault removal.

## Million-machine distributed injector plan

Do not attempt one million sockets from one injector host.

Shard the fleet across many injectors, each with a bounded connection count based on measured local limits. Use non-overlapping `load_machine_*` id ranges and the same report schema.

Example planning pattern only:

```text
injector-000: load_machine_000000000000 .. load_machine_000000024999
injector-001: load_machine_000000025000 .. load_machine_000000049999
...
```

The exact shard size is determined by injector CPU, memory, UDP socket, ephemeral-port and NIC measurements.

## Release blockers

Do not proceed to a production canary when any of these is true:

- capacity model fails;
- measured stable capacity is below the deployment plan;
- one-region failover exceeds the utilization ceiling;
- reconnect p99 or error rate exceeds the approved SLO;
- replacement fencing is incomplete;
- Redis outage leaves Gateway ready;
- Redis recovery requires manual state deletion;
- file descriptor or memory use grows without a stable plateau;
- test machine auth keys remain after cleanup;
- results cannot be tied to an exact release/configuration.

## Reporting

Every qualification report should state separately:

1. **modeled capacity**;
2. **measured live capacity**;
3. **hardware/topology used for measurement**;
4. **faults exercised**;
5. **SLOs passed/failed**.

Never merge these categories into one marketing number.
