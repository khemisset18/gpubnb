# Regional Connection Gateway v1

**Status:** implementation baseline / stacked on `GLOBAL_CONTROL_PLANE_V1`  
**Purpose:** persistent authenticated host control connections at multinational scale  
**Data plane:** unchanged; renter/workspace bytes remain on `services/edge`  
**Safety posture:** fail closed for identity, connection ownership, phase authority and lease-backed commands

## 1. Decision

GPUbnb introduces a dedicated **Regional Connection Gateway** process between GPU hosts and the durable control plane. A host establishes one long-lived outbound QUIC connection to a gateway in its selected region. The connection carries only bounded control messages: authentication, liveness, commands and acknowledgements.

The service does **not** carry renter bytes and does **not** own bookings or payments.

```text
                                 global API / booking plane
                                          |
                                  durable outbox/events
                                          |
                                regional control workers
                                   |             |
                          phase/command API      |
                                   |             |
                         +---------v-------------v---+
                         | Regional Control Gateway |
                         | QUIC + bounded journals  |
                         +---------+----------------+
                                   |
                           persistent outbound QUIC
                                   |
                              GPUbnb Host agent

 renter bytes: renter/client -> QUIC Edge -> host tunnel
 financial truth: PostgreSQL / settlement pipeline
 liveness truth: Gateway -> Redis presence hot state
```

A gateway may be destroyed and replaced. Correctness must not depend on its local memory surviving a process restart.

## 2. Why this is a separate service

The existing Edge is a renter-byte data plane and must remain independent from Redis and control-plane failures. Mixing host presence, resource scheduling and renter streams in the same process would create a shared failure domain: a Redis outage or reconnect storm could then degrade active renter traffic.

`services/control-gateway` therefore has its own executable, container, CI workflow, resource limits and operational runbook.

## 3. Wire protocol

ALPN: `gpubnb-control/1`  
Protocol version: `1`  
Transport: QUIC over TLS 1.3  
0-RTT: disabled

The first bidirectional stream is the only application control stream. Every message uses a four-byte big-endian length prefix followed by bounded JSON. The gateway rejects zero-length and over-limit frames before allocating unbounded payload memory.

Default maximum frame size is 64 KiB and has an absolute configuration cap of 256 KiB.

### 3.1 Client authentication

The agent sends a `ClientHello` containing:

- protocol version;
- machine id;
- key version;
- issue timestamp;
- cryptographic nonce;
- last terminal command sequence already acknowledged;
- Ed25519 signature.

The signature is over an explicit domain-separated canonical byte string:

```text
gpubnb-control-gateway-auth-v1
<protocolVersion>
<machineId>
<keyVersion>
<issuedAtMs>
<nonce>
<lastAckedCommandSequence>
```

This prevents a valid signature from another GPUbnb protocol from being replayed as a gateway login and binds reconnect/resume state to the authenticated machine.

The gateway resolves the machine public key from a Redis authentication projection:

```text
gpubnb:machine-auth:{<machineId>}:v1
  agentPublicKey = <base58 Ed25519 public key>
  keyVersion     = 1
  status         = ACTIVE | REVOKED
  updatedAtMs    = ...
```

PostgreSQL remains the durable source of truth. The API updates this projection when device authorization binds a Host key to a machine. The gateway never receives owner identity, email, billing data or session cookies.

Cache misses, revoked keys, version mismatch, timestamp skew and invalid signatures fail closed.

## 4. Connection ownership and split-brain fencing

After authentication, the gateway claims:

```text
gpubnb:machine-presence:{<machineId>}:v1
```

with a fresh random `connectionId`, gateway id, region and TTL. A subsequent connection atomically replaces that connection id.

Every heartbeat is accepted only when both conditions are true:

1. the Redis presence record still contains the connection's exact `connectionId`;
2. heartbeat sequence is strictly greater than the stored sequence.

Therefore an old gateway or old socket that survives a network partition cannot continue refreshing liveness after another connection wins ownership. On its next heartbeat it receives `STALE_CONNECTION`, is fenced and closes.

A disconnect deletes presence only if the disconnecting connection still owns the current `connectionId`. An old connection can never delete its successor's presence record.

## 5. Heartbeats prove liveness, not availability

The agent heartbeat carries only a monotonic sequence and observation time.

**The agent is not allowed to choose `AVAILABLE`, `MINING`, `RENTED` or another scheduler-visible phase in a heartbeat.**

Newly authenticated machines enter `DRAINING`, which is intentionally non-schedulable. Phase is changed only by the trusted regional control plane through the authenticated internal endpoint.

This prevents a compromised or stale agent from making itself rentable while a durable booking or another control worker says otherwise.

## 6. Authoritative phase transitions

Phase updates are fenced by two monotonic values:

- resource/control fencing token;
- phase sequence within that fencing epoch.

Redis keeps the last accepted pair in:

```text
gpubnb:machine-phase-fence:{<machineId>}:v1
```

The update transaction checks the current `connectionId`, compares fencing tokens as exact unsigned decimal strings, then compares the phase sequence. This avoids floating-point precision loss in Redis Lua for 64-bit tokens.

Rules:

- lower fencing token: reject;
- same token + lower phase sequence: reject;
- same token + same sequence + same phase: idempotent success;
- same token + same sequence + different phase: reject conflict;
- higher token, or same token + higher sequence: accept.

This lets one rental lifecycle progress `RESERVED -> PREPARING -> RENTED -> DRAINING` with one fence while stale workers from older epochs remain unable to overwrite newer state.

## 7. Command path

Commands are versioned `CommandEnvelope` objects with:

- globally unique command id;
- machine id;
- strictly increasing per-machine sequence;
- command kind;
- bounded issue/expiry window;
- optional resource lease binding;
- bounded JSON payload.

`PREPARE_RENTAL` and `START_RENTAL` require a live Redis resource lease. Before accepting them, the gateway verifies all four lease identity values against the current hot lease:

- `resourceId`;
- `holderId`;
- `leaseId`;
- `fencingToken`.

This blocks a stale scheduler process from sending a start command after its allocation was superseded.

Safety commands such as stop/quarantine are not made impossible merely because a rental lease expired; cleanup must remain possible during failure recovery.

## 8. Delivery, ACK and reconnect

The gateway uses a bounded in-memory per-machine journal as a **delivery cache**, not as the source of truth.

Properties:

- command sequence is strictly monotonic;
- duplicate identical command ids are idempotent;
- same id with different content is a conflict;
- bounded number of pending commands per machine;
- bounded per-connection send channel;
- no unbounded retry queue;
- expired commands are pruned;
- terminal ACKs are processed in order;
- `ACCEPTED` ACK does not remove a command;
- `SUCCEEDED`, `FAILED` and `REJECTED` are terminal;
- reconnect replays pending commands after `lastAckedCommandSequence`.

Terminal/accepted ACK state is persisted to a Redis key per command for 24 hours. Durable API outbox delivery remains responsible for retrying commands across a gateway process loss. A process restart may lose the local journal, but it cannot manufacture success and does not lose the durable command intent.

## 9. Backpressure and admission

Defaults are conservative and configurable within hard ranges:

| Limit | Default |
|---|---:|
| authenticated/open QUIC connections per gateway | 50,000 |
| outbound messages buffered per connection | 128 |
| pending commands per machine | 256 |
| command delivery-cache retention | 5 minutes |
| presence TTL | 60 seconds |
| heartbeat timeout | 45 seconds |
| max control frame | 64 KiB |

At 80% connection occupancy, the QUIC listener requires address validation for unvalidated peers. At capacity it refuses new handshakes instead of consuming memory and hoping the scheduler catches up.

When a per-connection channel is full, the command remains in the bounded journal and dispatch reports `QUEUED_BACKPRESSURE`. It is not copied into a second unbounded buffer.

## 10. Internal API

The admin/control listener exposes:

- `GET /healthz` — process liveness;
- `GET /readyz` — Redis connectivity + not draining;
- `GET /metrics` — low-cardinality Prometheus text;
- `POST /v1/internal/commands/{machineId}` — bounded command ingestion;
- `PUT /v1/internal/presence/{machineId}/phase` — fenced authoritative phase transition.

Mutation endpoints require `x-gpubnb-internal-token`. The listener must be reachable only from the private regional service network and additionally protected by network policy/service identity in production. The static token is a bootstrap defense, not a substitute for private-network policy or workload identity.

## 11. Failure model

### Gateway process dies

QUIC connections drop. Presence expires within TTL. Agents reconnect to another admitted gateway. Durable command outbox retries unacknowledged commands. No booking/payment mutation is inferred from the disconnect.

### Redis unavailable

New authentication/presence claims and heartbeats fail closed. Existing renter traffic on the Edge remains unaffected. Readiness becomes unhealthy so the gateway is removed from new regional admission.

### Two gateways believe they own one machine

Only the gateway whose random `connectionId` is present in Redis can refresh presence. The loser is fenced on heartbeat.

### Control worker retries an old phase transition

The persistent phase fence and phase sequence reject it.

### Stale scheduler sends a rental start

The gateway checks current `leaseId`, holder and fencing token immediately before journaling the command. Mismatch rejects the command.

### Agent reconnects after receiving but before ACKing a command

The signed hello includes the last terminal ACK sequence. The gateway replays newer journal entries. Command execution must remain idempotent on the agent side; that is the next Agent Control Channel layer.

## 12. Observability

Prometheus metrics intentionally contain no machine-id labels. Per-machine cardinality belongs in structured logs/traces sampled downstream, not metric dimensions.

Required alerts:

- Redis readiness failures;
- auth rejection rate anomaly;
- connection capacity > 80/90/95%;
- heartbeat rejection spike;
- command backpressure ratio;
- reconnect storm;
- command ACK latency/error budget;
- regional gateway count below N+1 capacity.

## 13. Deployment topology

A production region runs multiple independent gateway replicas across at least three failure domains where available. Regional routing never sends new hosts to a draining/degraded gateway. Capacity planning must retain enough spare replicas to absorb at least one AZ/failure-domain loss plus reconnect burst.

The container runs as non-root and exposes only UDP/4443 for QUIC and TCP/9090 for the private admin listener.

## 14. Rollout gates

This PR does not switch the current HTTP heartbeat path to the new gateway. Deployment order:

1. deploy gateways with no production agents;
2. validate Redis/auth projection and synthetic QUIC probes;
3. canary Agent Control Channel at <= 0.1%;
4. verify presence parity against legacy heartbeat;
5. increase to 1%, 5%, 25%, 50%, 100% only with SLO gates green;
6. separately cut scheduler reads from legacy presence to hot presence;
7. remove legacy polling only after command ACK and reconnect qualification.

Rollback is immediate: stop assigning agents to control gateways and retain the legacy HTTP control path while the feature flag remains enabled.

## 15. Explicit non-goals of this layer

This layer does not yet:

- modify the production agent to use the QUIC control channel;
- replace the durable API outbox with Kafka/Redpanda;
- remove legacy HTTP heartbeat/job polling;
- change renter-byte transport;
- change booking/payment/settlement authority;
- claim that one gateway process itself handles millions of sockets.

The scale target comes from horizontal regional sharding, bounded state per connection, failure-domain isolation and deterministic routing—not from an unsafe single giant process.
