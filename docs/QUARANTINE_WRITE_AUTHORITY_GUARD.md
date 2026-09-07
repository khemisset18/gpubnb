# Quarantine write-authority guard

## Purpose

GPUbnb already centralizes machine quarantine entry and exit in `apps/api/src/quarantine-service.ts`. That service updates the machine, mirrors accelerator moderation state, and appends durable `MachineQuarantineEvent` history inside the caller's transaction.

The reliability risk is regression: a future route, scheduler or reconciler could write `Machine.moderationStatus`, `quarantineReasonCode` or `quarantinedAt` directly and silently bypass the event history or accelerator synchronization.

`apps/api/test/quarantine-write-authority.test.ts` converts the architectural rule into a CI-enforced invariant.

## Enforced invariant

Production TypeScript under `apps/api/src` must not directly:

- assign `ModerationStatus.QUARANTINED` outside `quarantine-service.ts`;
- clear `quarantineReasonCode` outside `quarantine-service.ts`;
- clear `quarantinedAt` outside `quarantine-service.ts`.

The authority service itself is also checked for the expected machine-state writes, accelerator synchronization, and durable quarantine-event creation.

## Correct pattern

Any production path that needs to quarantine a machine must call `enterQuarantine(tx, input)` using the same database transaction as the failure/degradation decision that triggered the quarantine.

Any production path that needs to release a quarantine must call `clearQuarantine(tx, input)` through the existing diagnostic/admin policy. Do not replace this with a direct Prisma update.

This matters because machine state, accelerator state and quarantine history must change atomically. A direct write can make the machine appear clear while an accelerator remains quarantined, or erase the reason without preserving an audit event.

## What this guard intentionally does not forbid

Queries may filter or select `moderationStatus`, including `ModerationStatus.CLEAR`. Tests and fixtures may seed quarantined rows directly because they are not production write paths. The guard scans only `apps/api/src`.

## When adding a new quarantine reason

1. Add or reuse a stable reason code in the quarantine reason registry.
2. Call `enterQuarantine()` from the same transaction that proves the failure condition.
3. Preserve compare-and-set or ownership guards before destructive cross-entity side effects.
4. Add a focused behavior test for the triggering path.
5. Do not weaken or bypass `quarantine-write-authority.test.ts` to make the change pass.

See `docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md` for the full quarantine/diagnostic architecture and operational recovery flow.
