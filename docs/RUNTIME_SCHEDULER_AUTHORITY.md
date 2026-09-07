# GPUbnb runtime scheduler authority

Last audited: 2026-09-07.

GPUbnb can run more than one API replica and can also run the delivery worker at the same time. Background reconciliation therefore must never rely on process-local booleans as the only exclusion mechanism.

## Authorities

- `api-reconciliation-tick` fences the 10-second API reconciliation group across API replicas.
- `development-bookings` fences `reconcileDevelopmentBookings` across both API replicas and delivery-worker replicas.
- `api-sweep-tick` fences offline-machine and stale-job sweeps across API replicas.

The process-local `reconciling` and `sweeping` flags still prevent overlap inside one Node.js process, but Redis owns cross-process exclusion.

## Lease protocol

`runWithDistributedTaskLease` uses a unique owner token and an expiring Redis key:

1. acquire with `SET key token PX ttl NX`;
2. renew only when `GET key == token`, using `PEXPIRE`;
3. release only when `GET key == token`, using `DEL`;
4. never issue an unconditional delete;
5. if the last confirmed TTL deadline has elapsed, report `leaseLost=true` even if Redis was temporarily unreachable.

A lost lease is logged. These leases reduce duplicate scans and cross-replica contention; they are not a substitute for the existing idempotent/conditional database transitions inside each reconciler.

## Failure behavior

If another process already owns a task lease, the contender skips that tick. If Redis cannot be reached during acquisition, the tick fails and the existing outer error handling records the failure. If renewal temporarily fails before the confirmed TTL expires, the owner retries; once the deadline is exceeded, ownership is treated as lost.

The delivery worker and API deliberately use the same `development-bookings` key. This prevents the historical situation where the API ran that reconciler every 10 seconds while the delivery worker simultaneously ran it every second.

## Deployment rule

Do not add another recurring control-plane mutation directly to `setInterval`, a long-running worker loop, cron, or a second service without first deciding its distributed authority. A new task must be one of:

- inherently idempotent and safe to execute concurrently;
- fenced by an existing task-specific lease;
- given a new lease/fencing mechanism;
- moved to a single authoritative scheduler with documented failover.

Provider topology must not be encoded as a correctness assumption. The same code must remain safe when the API or worker replica count changes.
