# Redis state contract

Last audited: 2026-09-07.

Redis in GPUbnb is **not a disposable cache**. It is a provider-neutral control-plane dependency used for short-lived state whose correctness depends on atomic consume-once, compare-and-set, TTL, Lua transactions, bounded lists and stream publication.

The machine-readable contract is `deploy/redis-state-contract.json`. `deploy/runtime-processes.json` must expose the same required capabilities.

## Authority boundary

PostgreSQL remains authoritative for durable business state: users, machines, listings, bookings, jobs, attempts, workspace sessions, resource allocations, payments, audit history and the durable outbox.

Redis is authoritative only for short-lived coordination windows where process memory is insufficient and plain CRUD would introduce races. Loss of Redis may delay or reject new control-plane work, but must not rewrite durable business history.

## State classes

### Authentication nonces and one-time grants

Wallet nonces, machine link codes, agent heartbeat challenges and workspace bootstrap grants must be consumed atomically. The current implementation uses `GETDEL` or an equivalent atomic one-shot primitive.

A migration is invalid if it implements `GET` followed by `DELETE`, because two concurrent requests can both observe the credential before either deletes it.

### Agent anti-replay

Signed agent requests use `SET ... NX` with expiration so the same signature cannot be accepted by two concurrent API replicas. This is part of request authentication, not an optimization.

### Machine presence

Presence claims and heartbeats are connection-owned and TTL-bound. Lua scripts ensure a stale connection cannot refresh or release another connection's presence record.

### Resource and scheduler leases

GPU resource authority and background scheduler authority rely on expiring leases. Renewal and release must verify the current owner before mutating the lease. Resource leases additionally use fencing tokens so a stale owner cannot act as if it were current after another owner acquires the resource.

Never replace this with an `AVAILABLE=true` flag or an unconditional `DEL`.

### Workspace gateway relay

Workspace relay queues are ephemeral but correctness-sensitive. Queue insertion is bounded by item and byte budgets, queue state expires, and dequeue accounting is maintained. Backpressure is a safety mechanism: removing it can turn a slow renter/host connection into unbounded Redis or process memory growth.

### Outbox stream publication

The durable outbox is PostgreSQL. The delivery worker publishes claimed durable events to Redis Streams for downstream delivery. Redis Streams are therefore a transport surface, not the business source of record. A stream can be rebuilt/replayed from durable outbox state according to the delivery policy.

## Failure policy

Redis failure must be handled fail-closed for operations whose security or ownership proof depends on Redis. Do not silently fall back to process memory in production: replicas would then disagree about nonce consumption, lease ownership and presence.

API readiness already requires Redis. The control gateway also becomes unready when Redis is unavailable. Operators should restore Redis connectivity rather than bypass readiness.

Existing durable bookings/jobs remain in PostgreSQL during a Redis outage. Recovery must prefer re-establishing short-lived coordination state from durable state and fresh agent heartbeats instead of fabricating old leases or grants.

## Provider migration rule

Redis may be supplied by any compatible managed provider. The provider name is not architecture. The semantics are.

A proposal to replace Redis with Supabase/PostgreSQL, a queue product or another key-value system must map every affected state class to equivalent primitives and prove them under concurrency. At minimum:

1. consume-once credentials remain atomic;
2. anti-replay remains atomic across replicas;
3. TTL is server-enforced;
4. lease renew/release is ownership checked;
5. fencing tokens remain monotonic where required;
6. gateway queues remain bounded and backpressured;
7. stream/outbox delivery remains replayable from durable state;
8. multi-replica and outage tests pass before cutover.

Do not migrate all Redis state as one undifferentiated project. Migrate one state class at a time, shadow it where possible, test faults, then cut over.

## Operational checks

Before a production release or provider change:

- verify `REDIS_URL` is configured for API and delivery-worker;
- verify the Redis service supports the capabilities listed in `deploy/redis-state-contract.json`;
- run the full API suite and the distributed scheduler/lease tests;
- verify `/ready` fails when Redis is unavailable and recovers after connectivity returns;
- exercise one-time nonce/grant replay tests;
- exercise resource/scheduler lease ownership loss;
- exercise workspace gateway queue backpressure;
- verify durable outbox rows are not lost when stream publication temporarily fails.

## Deletion criterion

`REDIS_URL` may be removed from a runtime role only after every state class used by that role has an explicitly implemented replacement, its fault/concurrency tests are in CI, its migration runbook is documented, and the runtime topology contract is updated in the same reviewed change.
