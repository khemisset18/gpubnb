# Workspace gateway generation fencing

This document defines the admission and revocation rules for Agent-to-browser
WebSocket frames. It covers synthetic/internal qualification; it is not evidence
that a physical GPU video stream has been exercised.

## Authority model

The generation is the UUID of the durable `WorkspaceGatewayAcceptance` receipt
created for the first accepted upstream frame. Redis stores that UUID under
`workspace-gateway:ws-session-activated:<sessionId>` as a two-second lease.

- The hot frame path reads the lease and presents the exact UUID to the enqueue
  Lua script. That script atomically checks channel binding, native browser
  cookie, generation, queue limits and enqueue. It cannot create authority.
- A missing or legacy lease requires a fresh PostgreSQL read, bounded to four
  seconds. Only an active, unexpired session on a clear online machine with a
  committed receipt may CAS-install the receipt. A tombstone or another receipt
  is never overwritten.

- Lease expiry bounds stale authority after DB-only status, connectivity or
  moderation changes. A PostgreSQL failure during renewal refuses the frame.
  Redis read, CAS or enqueue failures before admission refuse the frame. Once
  the first payload and its receipt are committed, a subsequent authority
  publication failure preserves that accepted result but returns no authority
  for readiness; later frames require a fresh successful renewal.

- Before the PostgreSQL read, renewal samples Redis `TIME` and fixes a
  15-second validation deadline. The install Lua checks that deadline using
  Redis's clock, including after a first-frame transaction or lost commit ACK.
  It is never refreshed during recovery. If a first-frame transaction outlives
  that deadline, one new attempt samples Redis again and reads a fresh active
  PostgreSQL snapshot with the same committed receipt; the Redis CAS still
  refuses a tombstone or different generation. An already activated session
  also revalidates against the durable receipt when its initial snapshot expires.
  Caller timeouts do not cancel queued
  Redis commands: an expired validation must be refused even after the STOP
  tombstone has disappeared. The deadline is shorter than the 60-second minimum
  tombstone lifetime. Only renewal/first activation adds this `TIME` call; the
  hot frame path remains unchanged. Missing deadlines fail closed, so mixed
  API versions must be drained before relying on this guarantee.

Redis documents [atomic script execution](https://redis.io/docs/latest/develop/programmability/eval-intro/)
and its [server clock](https://redis.io/docs/latest/commands/time/). Both the
sample and comparison use that clock, avoiding API/Redis clock skew. Normal
Redis expiry assumptions still apply (no backward server-clock jumps or restore
of stale authority from a snapshot).

The valid lease is deliberately short but authoritative for its remaining
lifetime. Therefore loss of PostgreSQL after a successful renewal can leave at
most two seconds of already-issued authority; it cannot create or extend a
lease. Per-frame readiness updates do not refresh it.

A Redis-only hot-path frame does not refresh browser, channel or authority TTLs because it has no
authoritative session expiry snapshot. It does publish the legacy upstream-ready
hint, bounded atomically by the minimum remaining browser/channel PTTL, after
checking the exact channel binding and generation. Missing or persistent
bindings are refused. This lets a second legacy channel open while another
channel keeps the session generation hot. The hint does not authorize delivery.
The next PostgreSQL-backed lease renewal may refresh bindings, bounded by the
freshly read `expiresAt`.

## First-frame billing

The first frame has no generation. It retains the exclusive PostgreSQL session
row lock, verifies the billing predicates, atomically enqueues only while the
Redis authority key is absent, activates billing, and commits the durable
receipt. The committed receipt is then CAS-installed as the lease. A refused or
unknown Redis acceptance cannot commit billing. An uncommitted accepted frame
is receipt-gated and compensated when absence of the receipt is known.

## STOP and in-flight frames

STOP first commits its monotonic PostgreSQL transition, then replaces the Redis
generation with a `revoked:<uuid>` tombstone before reporting success. Agent
revocation, Agent cleanup and verified finalization use the same tombstone. It
lives for at least 60 seconds, longer than any bounded authority read.

The tombstone write is the Redis admission linearization point:

- an enqueue EVAL completed before it is an admitted in-flight frame;
- an EVAL starting or completing after it is refused;
- a caller that read the old generation before STOP but reaches EVAL afterward
  is refused because generation comparison occurs inside that EVAL;
- bytes already written to a socket or kernel buffer cannot be recalled, while
  buffered delivery still passes the final database, channel and cookie fences.

If tombstone publication fails, STOP returns an error even though its monotonic
database transition may already have committed. New renewal reads then fail the
database predicate, and any previously issued Redis lease expires within two
seconds. Retrying STOP republishes the tombstone idempotently.

## Reconnection and input

A tombstone cannot be migrated back to a receipt. After it expires, the durable
terminal database status still prevents renewal. A new connection must obtain
new channel and browser bindings; an old connection cannot reactivate itself.

Keyboard and mouse commands do not rely on the video lease. They retain the
native database mutation fence plus final Redis binding/cookie checks, so stale
commands, old epochs and revoked channels are rejected. STOP and WTS cleanup
release held keys and buttons in the Windows helper path.

## Qualification invariants

Tests must prove all of the following:

1. A hot valid generation performs no PostgreSQL read or transaction per frame.
2. Missing/legacy authority performs a bounded authoritative read and CAS.
3. Enqueue scripts never install missing authority.
4. STOP does not wait for delayed hot-path EVALs, and those EVALs return refusal
   once its tombstone has been written.
5. The first frame cannot activate billing without a committed receipt-gated
   enqueue.
6. PostgreSQL renewal failure, Redis failure, backpressure and malformed
   generations fail closed.
7. A hot-path frame without `expiresAt` cannot replace the session-bounded Redis
   TTLs with the one-hour fallback.
