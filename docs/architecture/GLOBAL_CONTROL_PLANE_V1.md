# GPUbnb Global Control Plane v1

**Status:** architecture baseline / staged migration foundation  
**Scope:** millions of users and potentially millions of connected GPU hosts  
**Safety posture:** fail closed for ownership, leases, security and payments  
**Data plane:** the existing regional QUIC Edge remains the renter-byte transport and is intentionally not replaced here

## 1. Executive decision

GPUbnb must not scale the current architecture by multiplying replicas of one central Fastify API. A machine heartbeat, control command, renter byte stream, marketplace query and financial booking do not have the same consistency or latency requirements and must not share the same hot path.

The target architecture separates four planes:

1. **Global API plane** — identity, marketplace, booking intent and public product APIs.
2. **Regional control plane** — long-lived host connections, presence, commands, leases and scheduler-facing availability.
3. **Regional data plane** — the existing QUIC Edge that carries renter/workspace traffic without routing renter bytes through PostgreSQL or Redis.
4. **Durable transaction plane** — PostgreSQL for bookings, payments, audit state and other records that must survive cache loss.

```text
                           users / API clients
                                  |
                        Global Anycast / WAF
                                  |
                   +--------------+--------------+
                   |                             |
              API region EU                 API region US
                   |                             |
                   +---------- event bus --------+
                              /       \
                             /         \
                  Control EU           Control US
                 /    |    \           /    |    \
            gateway gateway gateway  gateway gateway gateway
               |       |      |         |       |      |
             QUIC    QUIC   QUIC      QUIC    QUIC   QUIC
               |       |      |         |       |      |
             hosts   hosts  hosts      hosts   hosts  hosts

          renter traffic: browser/client -> nearest Edge -> host tunnel
          financial truth: booking/payment services -> PostgreSQL
          online truth: regional control gateway -> Redis hot state
```

The architecture is **active-active by region**, but not every data class is multi-writer. GPUbnb explicitly assigns one owner for each kind of state.

## 2. Why the existing heartbeat path cannot be the million-host hot path

The current signed heartbeat path is appropriate for Devnet and early production because it verifies machine identity, anti-replay state and accelerator security before changing availability. It also touches durable database state.

At one million machines, a ten-second heartbeat interval is approximately **100,000 heartbeat attempts per second** before jobs, users, bookings, metrics or reconnect storms are counted. The solution is not to remove the existing security checks. The solution is to move high-frequency liveness into a regional connection service and keep durable writes out of the liveness loop.

Target rule:

> **A keepalive proves that a connection is alive. It must not imply a PostgreSQL transaction.**

Durable machine inventory changes, moderation changes, booking changes and billing evidence still belong in durable storage. Ephemeral liveness belongs in the hot-state tier.

## 3. State ownership

| State | Source of truth | Consistency | Notes |
|---|---|---|---|
| User identity / account | PostgreSQL | strong | durable |
| Booking / payment / settlement | PostgreSQL + chain evidence | strong | financial correctness wins over latency |
| Machine registration / public key | PostgreSQL | strong | security identity |
| Static hardware inventory | PostgreSQL | strong/eventual refresh | change only after signed inventory validation |
| Machine online presence | Redis regional hot state | bounded TTL | never one DB write per keepalive |
| Current connection owner | Redis regional hot state | atomic/fenced | `connectionId` prevents stale gateways |
| GPU allocation lease | Redis lease + durable booking transaction | atomic/fenced | fencing token required downstream |
| Command delivery state | durable outbox + regional gateway | at-least-once + idempotent | sequence and ACK |
| Marketplace search index | regional/search index | eventual | rebuilt from durable events |
| High-rate telemetry | telemetry pipeline / time-series store | eventual | not PostgreSQL OLTP |
| Billing usage evidence | durable append-only store | strong retention | survives raw telemetry retention |
| Renter workspace bytes | memory / QUIC Edge | streaming | never Redis/Postgres message payload |

## 4. Regional connection gateways

A host establishes one long-lived outbound control connection to a regional `Connection Gateway`. QUIC is preferred because the repository already operates a QUIC data-plane stack and QUIC handles NAT rebinding, multiplexing and recovery well. A WebSocket fallback can exist for networks that block UDP, but it is a compatibility path rather than the architectural center.

A gateway is deliberately narrow. It owns:

- authenticated machine connections;
- connection keepalive and timeout;
- machine presence publication;
- command push and ACK collection;
- connection resume metadata;
- local admission control;
- backpressure;
- region/gateway identity;
- no financial authority.

A gateway **must not** independently decide that a renter owns a GPU. It executes commands that are backed by a valid resource lease and durable booking state.

### 4.1 Connection lifecycle

```text
DISCONNECTED
    |
    v
AUTHENTICATING --invalid signature/key--> REJECTED
    |
    v
CONNECTED
    |
    +--> PRESENCE_CLAIMED
    |        |
    |        +--> command stream / keepalive / telemetry summary
    |
    +--reconnect--> new connectionId fences old connection
    |
    +--timeout/drain--> presence TTL expires or fenced release
```

Every newly authenticated connection receives a cryptographically random `connectionId`. Presence updates are accepted only from the connection that currently owns that ID. A later connection atomically replaces it. Frames from an old socket are therefore harmless after reconnect or split-brain.

This PR implements the Redis contract in `machine-presence.ts`.

## 5. Presence hot state

The presence record is intentionally compact. It is not a telemetry document.

Conceptual record:

```json
{
  "machineId": "...",
  "connectionId": "conn_...",
  "gatewayId": "gateway_eu_...",
  "region": "eu-west",
  "sequence": 8142,
  "phase": "AVAILABLE",
  "lastSeenAtMs": 1786744800000
}
```

Allowed phases are bounded to the scheduler-relevant lifecycle:

```text
AVAILABLE
MINING
RESERVED
PREPARING
RENTED
DRAINING
QUARANTINED
```

Properties:

- Redis Cluster key contains a per-machine hash tag.
- Claim is atomic.
- Touch is accepted only for the active `connectionId`.
- Sequence must increase monotonically inside a connection.
- TTL is bounded to 15–300 seconds.
- Explicit release is fenced by `connectionId`.
- TTL expiry is the final fallback when a gateway disappears without cleanup.

Presence is **not enough to allocate a GPU**. Allocation requires a separate lease.

## 6. Global resource lease and fencing

A distributed scheduler must never use `AVAILABLE=true` as a lock. Two schedulers can observe the same availability concurrently.

GPUbnb therefore uses an expiring resource lease:

```text
AVAILABLE
   |
   | atomic acquire
   v
LEASED(resource, holder, leaseId, fencingToken, ttl)
   |
   +--> renew while workflow is valid
   |
   +--> release after verified cleanup
   |
   +--> expiry after owner failure
```

The critical value is the **fencing token**. It increases every time the resource receives a new lease. Any downstream operation that mutates GPU ownership must carry the token. A worker with token `41` cannot stop, release or overwrite a runtime owned by token `42`.

The lease key and fencing counter share the same Redis Cluster hash tag, so acquisition can be one atomic Lua operation even in a cluster.

The fencing counter is intentionally not deleted when a lease is released. Production Redis for this service must have persistence and failover configured so fencing does not reset during ordinary node loss.

### 6.1 Idempotency

An acquire request is idempotent for the same `(resourceId, holderId, idempotencyKey)`. Retrying after a timeout returns the existing lease instead of manufacturing a second logical ownership event.

A different holder receives `BUSY` until release or expiry.

This PR implements the contract in `resource-lease.ts`.

## 7. Scheduler architecture

The scheduler is not implemented in this foundation PR, but its contract is fixed by the state model.

The scheduler must query an availability index, not scan the `Machine` table for every user request.

```text
request
  |
  +--> regional/capability candidate index
  |       filters: GPU model/vendor, VRAM, workspace, price, moderation, region
  |
  +--> bounded candidate set
  |
  +--> ranking: latency, price, reliability, utilization, locality
  |
  +--> atomic resource lease
  |       contention => try next candidate
  |
  +--> durable booking/allocation transaction
  |
  +--> command outbox
  |
  +--> gateway pushes PREEMPT/START
```

Index updates are event-driven from machine presence, inventory and durable marketplace events. The index is disposable: it must be rebuildable from source-of-truth data.

## 8. Mining to rental preemption

GPUbnb supports useful work/mining while a host is idle, but rental ownership always has priority.

The cloud must not directly kill miner processes. It sends an intent backed by a valid lease. The local GPU supervisor/agent is the authority over the physical device.

```text
MINING
  |
  | PREEMPT(fencingToken=N)
  v
PREEMPTING
  |
  +--> stop GPUbnb-owned miner
  +--> verify process death
  +--> verify GPU compute state is clean
  +--> verify stale containers are absent
  v
PREPARING
  |
  +--> start digest-pinned workspace
  +--> health check
  +--> establish data plane
  v
RENTED
```

After the rental ends, cleanup must be verified before mining can resume. A cleanup failure results in quarantine/degraded state, never an optimistic `AVAILABLE`.

The repository's existing `mining_guard.py`, workspace adoption and cleanup logic remain valuable components of this model.

## 9. Regional routing

Connection routing and renter data routing are separate decisions.

For machine control connections, the regional router considers only gateways in `READY` state and below a configured utilization ceiling. `DRAINING`, `DEGRADED` and `OFFLINE` gateways do not receive new machines.

The baseline ranking implemented in `regional-routing.ts` uses:

- preferred region order;
- observed RTT;
- connection utilization;
- recent error rate;
- deterministic machine/gateway tie-break.

Determinism matters during large reconnect waves: random routing makes behavior harder to reproduce and can amplify oscillation.

Production global load balancing may first direct a host toward a geographic region using Anycast/GeoDNS. The regional policy then selects an admitted gateway instance.

## 10. Event bus contract

Services communicate durable facts through versioned events rather than directly sharing mutable database tables.

Examples:

```text
machine.connected
machine.presence.updated
machine.disconnected
machine.quarantined
resource.lease.acquired
resource.lease.renewed
resource.lease.released
rental.preemption.requested
rental.preemption.completed
rental.runtime.ready
rental.runtime.stopped
```

`control-plane-events.ts` defines:

- schema version;
- unique event ID;
- aggregate ID;
- partition key;
- deterministic partition;
- region;
- UTC occurrence time;
- bounded payload.

Events for one aggregate use the same partition key, preserving order where the broker provides partition ordering. Consumers remain idempotent because delivery is at-least-once.

The repository already contains outbox and reliable-delivery primitives. A future broker adapter (Kafka/Redpanda/Pulsar or managed equivalent) should consume the outbox rather than letting application transactions publish directly to the broker.

## 11. Data plane remains separate

Renter interactive bytes have fundamentally different requirements from control messages.

The existing `services/edge` QUIC data plane already establishes the correct boundary:

- renter bytes are not Redis messages;
- renter bytes are not PostgreSQL rows;
- authority is scoped and short-lived;
- Edge has bounded resources and abuse controls;
- traffic is relayed in memory over QUIC.

The control-plane work in this document must not merge those paths back together.

## 12. Database strategy

PostgreSQL remains the durable transactional database, but it stops being a high-frequency presence cache.

Recommended topology at scale:

- regional read replicas for marketplace/account reads where consistency permits;
- a clearly owned write region or partition for each financial aggregate;
- connection pooling/proxy in front of PostgreSQL;
- serializable/explicit locking only around business invariants that require it;
- transactional outbox for events;
- partition/retention policy for append-only evidence tables;
- no raw high-rate telemetry in primary OLTP tables indefinitely.

Multi-region active-active does **not** mean "all regions write every row". Financial correctness requires an ownership strategy that avoids conflict-prone multi-master writes.

## 13. Telemetry strategy

Three classes of data must remain separate:

1. **Presence** — tiny, latest-value, TTL, Redis.
2. **Operational metrics** — high-rate time series, observability/telemetry store.
3. **Billing evidence** — durable, append-only, retained long enough for settlement/disputes.

Sampling and aggregation happen before long-term storage. A reconnect storm must not create a billing or database storm.

## 14. Security invariants

These are non-negotiable at every scale:

- machine identity remains cryptographically authenticated;
- remote APIs use TLS; production Redis is private/TLS and authenticated;
- anti-replay remains enforced;
- a new connection fences an old connection;
- a new resource lease fences an old worker;
- booking/payment authority never comes from ephemeral presence alone;
- moderation/quarantine overrides availability;
- no public host listener is required;
- workspace containers remain hardened and isolated;
- secrets are not placed on process command lines;
- control/event payloads are size bounded;
- every queue and in-memory fan-out has an explicit limit;
- cleanup uncertainty fails closed.

## 15. Failure model

### Gateway process dies

- QUIC/WebSocket connections disappear.
- Presence expires by TTL.
- Hosts reconnect through global/regional routing.
- New `connectionId` fences delayed frames from the dead gateway.
- Durable commands remain in outbox/delivery storage and can be replayed idempotently.

### Redis primary fails

- Regional Redis failover takes over.
- Presence may be recreated by reconnect/touch.
- Resource fencing counters require persistence; if lease durability cannot be trusted, the scheduler must stop issuing new allocations until the store is healthy.
- Financial state remains in PostgreSQL.

### Event broker unavailable

- Application transactions write the durable outbox.
- Publishers retry with bounded backoff.
- Core booking transaction does not silently lose its event.

### PostgreSQL unavailable

- Existing data-plane sessions can continue for a bounded policy window if their authority remains valid.
- New financial bookings/settlements fail closed.
- Presence can continue independently, preventing a database outage from creating a reconnect amplification loop.

### Region unavailable

- New users/hosts are routed to a healthy region according to policy.
- Host reconnect creates a new connection owner.
- Resource ownership is not guessed. Cross-region recovery follows durable booking + lease recovery rules.

### Network partition / split brain

- connection ID fences old control connection;
- fencing token fences old allocation owner;
- command sequence/idempotency prevents duplicate logical execution;
- financial aggregate ownership remains single-writer by policy.

## 16. Capacity model and admission control

The system is designed by **bounded work per connection**, not by assuming infinite queues.

Every gateway deployment must declare:

- maximum concurrent host connections;
- maximum new handshakes per second;
- command queue limit per machine;
- global command queue memory limit;
- keepalive interval and timeout;
- maximum control frame bytes;
- maximum telemetry summary bytes;
- maximum in-flight broker publishes;
- graceful drain rate.

Regional routing stops admitting new connections before 100% capacity. The baseline code uses 95% as the default ceiling.

Capacity testing must include reconnect storms, not only steady state. A deployment that supports 200k stable sockets but collapses when 50k reconnect simultaneously is not qualified.

## 17. SLO targets for the mature system

These are architecture targets, not claims about the current Devnet deployment.

| Operation | Target |
|---|---|
| Regional control gateway availability | >= 99.99% per qualified region |
| Presence update processing p99 | < 100 ms inside region |
| Scheduler lease acquisition p99 | < 150 ms inside region |
| Command enqueue -> gateway delivery p99 | < 500 ms when host connected |
| Host reconnect p95 after gateway loss | < 5 s |
| Stale presence removal | within configured TTL |
| Double-allocation due to stale worker | 0 tolerated; fencing required |
| Lost durable booking event | 0 tolerated; outbox required |

## 18. Migration plan

The migration must be reversible at every phase.

### Phase 0 — `legacy` (default in this PR)

- Existing heartbeat/database path remains authoritative.
- New control-plane modules are inert libraries.
- No production behavior change.

### Phase 1 — `shadow`

- After the existing signed heartbeat is fully verified, write compact presence to Redis as a shadow copy.
- No scheduler or marketplace decision reads the shadow copy.
- Compare online/offline, phase and sequence parity continuously.
- Alert on divergence.

Exit gates:

- >= 7 days parity at target canary volume;
- no unexplained stale-owner events;
- Redis failover tested;
- reconnect storm test passed.

### Phase 2 — Regional connection gateway canary

- Agent opens persistent control channel in addition to legacy heartbeat.
- Gateway writes presence and receives commands in shadow mode.
- Legacy polling remains fallback.

Exit gates:

- command ACK parity;
- reconnect p95 target;
- bounded memory under synthetic storm;
- gateway graceful drain proven.

### Phase 3 — Hot presence cutover

- Marketplace/scheduler uses Redis presence for liveness.
- PostgreSQL no longer receives one durable liveness write per keepalive.
- Durable inventory/security changes still update PostgreSQL.

Rollback: switch read authority to legacy without schema rollback.

### Phase 4 — Global lease scheduler

- Availability index supplies bounded candidate lists.
- Every allocation obtains fenced resource lease before workflow dispatch.
- Existing database allocation constraints remain a second line of defense during transition.

### Phase 5 — Remove legacy polling

Only after persistent control channel, command ACK/replay and rollback drills have passed production canary qualification.

## 19. Rollout gates

No global rollout is authorized only because unit tests are green.

Required evidence:

- API unit/build checks green;
- Redis Cluster slot correctness test;
- Redis primary failover test;
- stale gateway fencing test;
- stale resource-owner fencing test;
- 10x expected reconnect burst test;
- command queue saturation test;
- broker outage/outbox recovery test;
- PostgreSQL outage isolation test;
- regional drain test;
- multi-region failover game day;
- data-plane canary remains healthy;
- security review of control authentication and lease consumers.

Suggested progression:

```text
local -> CI -> staging -> 0.1% -> 1% -> 5% -> 25% -> 50% -> 100%
```

Each stage has an automatic rollback threshold for error rate, reconnect time, stale presence, lease contention anomalies and command latency.

## 20. Observability

Minimum metrics by region/gateway:

```text
control_connections_current
control_connections_open_total
control_connections_closed_total
control_handshake_seconds
control_reconnect_total
presence_claim_total
presence_touch_total
presence_stale_connection_total
presence_stale_sequence_total
presence_expired_total
resource_lease_acquire_total
resource_lease_busy_total
resource_lease_stale_mutation_total
resource_lease_expired_total
command_enqueued_total
command_ack_total
command_redelivery_total
command_dead_letter_total
gateway_utilization_ratio
gateway_event_loop_lag_seconds
```

Logs include machine/gateway/event IDs but never private keys, bearer authorities, session cookies or raw renter payloads.

Distributed traces must cross API -> scheduler -> lease -> outbox -> gateway, but sampling is mandatory at high volume.

## 21. What this PR implements

This PR is intentionally a **foundation and migration PR**, not a dishonest claim that one commit deploys a million-machine network.

Implemented now:

- `machine-presence.ts` — Redis hot-state contract with connection fencing, monotonic sequence and TTL.
- `resource-lease.ts` — Redis Cluster-safe lease acquisition, renewal, release and monotonic fencing token.
- `control-plane-events.ts` — versioned and bounded event contracts with deterministic partitioning.
- `regional-routing.ts` — bounded regional gateway admission/ranking.
- staged environment/configuration flags with `legacy` as the safe default.
- unit tests for fencing, replay/order rejection, routing and event bounds.

Not switched on by this PR:

- dedicated long-lived Connection Gateway service;
- agent persistent control transport;
- shadow heartbeat dual-write;
- scheduler/search-index implementation;
- event-broker adapter;
- telemetry backend migration.

Those are follow-up PRs and are ordered deliberately so GPUbnb can prove each invariant before it becomes authoritative.

## 22. Follow-up PR sequence

1. **Regional Connection Gateway v1** — Rust service, long-lived authenticated QUIC control sockets, bounded queues, metrics, drain.
2. **Agent Control Channel v1** — persistent channel + reconnect/resume while retaining legacy heartbeat fallback.
3. **Presence Shadow Writer** — dual-write verified heartbeat into the new hot-state contract, parity dashboards.
4. **Command Push + ACK** — consume existing durable machine commands and eliminate job polling for canary hosts.
5. **Availability Index + Scheduler** — bounded candidate lookup and fenced lease acquisition.
6. **Hot Presence Cutover** — marketplace/scheduler liveness reads Redis, durable DB heartbeat writes reduced.
7. **Regional Event Broker Adapter** — transactional outbox publisher and idempotent consumers.
8. **Telemetry Separation** — operational time series off OLTP while preserving billing evidence.

The architectural rule for all follow-ups is the same: **new path in shadow, prove parity, canary, then authority; never a global big-bang migration.**
