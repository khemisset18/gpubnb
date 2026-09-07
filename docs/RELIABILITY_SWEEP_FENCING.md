# Cross-replica sweep fencing

## Why this exists

GPUbnb has destructive periodic maintenance jobs that can change machine, listing, booking, workspace, job, lease and payment state. In a single-process deployment, only one scheduler normally executes each sweep. In a multi-replica API/worker deployment, two replicas can enter the same sweep at nearly the same time and independently evaluate the same mutable rows.

That creates avoidable race windows around offline-machine handling and stale-job handling. The reliability rule is therefore: **only one transaction may execute a given destructive sweep at a time across all replicas that share the same PostgreSQL database.**

## Implementation

`apps/api/src/transaction-advisory-lock.ts` exposes `tryTransactionAdvisoryLock(tx, taskName)`.

The helper uses PostgreSQL `pg_try_advisory_xact_lock(hashtextextended(taskName, 0))`. The important property is the `_xact_` scope: the lock belongs to the current database transaction and PostgreSQL releases it automatically on commit, rollback, connection loss or process crash.

The helper is intentionally non-blocking. If another transaction already owns the same task lock, it returns `false` immediately instead of waiting. The caller then returns a zero-effect sweep result and lets the next scheduled tick try again.

Task names are validated before being passed to PostgreSQL. They are stable application constants, not user-controlled identifiers.

## Fenced tasks

### Offline-machine sweep

`apps/api/src/offline-sweep-service.ts` acquires `gpubnb:offline-sweep` inside the existing Serializable `runBookingTransaction` callback **before the first machine read**.

Only the lock owner may evaluate and mutate the machine/listing/booking/workspace/job/payment state for that tick. A contending replica returns an empty result for the same cutoff time.

### Stale-job sweep

`apps/api/src/job-staleness-sweep.ts` acquires `gpubnb:stale-job-sweep` inside the existing Serializable `runBookingTransaction` callback **before the first stale-job read**.

Only the lock owner may decide that a lease is expired, mark jobs timed out/failed, degrade bookings, fail sessions, change payment settlement state, release a safe RESERVED machine, or quarantine a host.

## Interaction with Serializable retries

The advisory lock lives inside `runBookingTransaction`. If PostgreSQL aborts the Serializable transaction with a retryable conflict, the entire callback is replayed and must reacquire the advisory lock in the new transaction.

This is safe because these sweep callbacks remain database-only. Do not put Redis operations, Docker operations, HTTP calls, WebSocket actions or other external side effects inside the retried transaction callback.

The two mechanisms solve different problems:

- Serializable retry handles transaction conflicts and write skew detected by PostgreSQL.
- The advisory lock prevents two replicas from intentionally executing the same destructive scheduler task concurrently.

Both protections are required for a multi-replica-safe maintenance path.

## Lease and quarantine safety rule

The stale-job sweep must continue to respect explicit job leases. A claimed job with a live `leaseExpiresAt` must not be considered stale merely because `updatedAt` is old. The legacy `updatedAt` fallback exists only for claimed rows that do not yet have an explicit lease.

A lost compare-and-set race must produce no booking, workspace, payment or quarantine side effects for that job. The sweep may quarantine only after it successfully transitions the stale claimed job inside the same transaction.

## Test requirements

Tests that call a fenced sweep through a fake Prisma transaction client must implement `$queryRaw` and return an advisory-lock result. Use `{ acquired: true }` when testing the normal lock-owner path.

The dedicated advisory-lock regression test verifies:

- the helper returns `true` and `false` from PostgreSQL results;
- invalid task names are rejected;
- each destructive sweep acquires its lock before its first mutable-state read.

The existing lease tests must remain in place, especially the 30-second API/agent interruption scenario against the 90-second job lease.

## Operational behavior

Seeing a zero-effect sweep result does not necessarily mean there was nothing to process; it can also mean another replica owned the advisory lock for that tick. This is expected and is safer than duplicate destructive work.

If a sweep appears permanently inactive, check database connectivity and scheduler execution first. PostgreSQL transaction-scoped advisory locks cannot remain orphaned after the owning transaction or connection dies.

## Invariants for future changes

Do not change these rules without a focused reliability review:

1. Acquire the task advisory lock inside the same Serializable transaction that performs the destructive sweep.
2. Acquire it before reading the mutable set that drives decisions.
3. Keep the lock name stable and specific to one logical task.
4. Treat lock contention as a skipped tick, not as an application failure.
5. Keep retried transaction callbacks free of external side effects.
6. Preserve explicit job-lease precedence over `updatedAt` for claimed jobs.
7. Preserve compare-and-set guards before quarantine or cross-entity degradation.
