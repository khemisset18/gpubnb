# GPU rental production hardening v1

## Status

This document records the software hardening performed on draft PR #126, stacked on PR #125. It is not a physical product qualification and does not authorize deployment or merge.

## Exact-GPU product authority

The private-beta rental product no longer treats a generic `Machine` GPU summary as the rentable resource. New rental listings are `SELECTED_ACCELERATORS` listings with exactly one `ListingAccelerator` pointing to a legacy `Accelerator` row whose hardware UUID is synchronized from heartbeat telemetry.

Publication requires, fail-closed:

- owner-controlled machine;
- fresh online machine state;
- successful Host/GPU verification;
- exact `Accelerator` available and not quarantined;
- verified isolation;
- fresh accelerator telemetry;
- `Accelerator -> MiningResource` authority present;
- GPU resource enabled, fresh, non-quarantined and in a safe runtime state;
- no conflicting live allocation;
- no duplicate non-archived listing for the same accelerator.

Publication and resource allocation use the same machine-scoped PostgreSQL advisory lock and serializable transactions.

## Heartbeat inventory bridge

The accelerator heartbeat path synchronizes modern `MachineAccelerator` telemetry into the legacy rental authority in the same transaction:

- stable hardware UUID identity;
- legacy Accelerator vendor/model/VRAM/driver/CUDA;
- operational and moderation state;
- isolation proof;
- verification timestamp;
- `MiningResource` mapping and freshness;
- stale resources disabled and missing accelerators marked missing.

This is intended to prevent the dual-inventory drift that previously surfaced as `rental_gpu_resource_mapping_missing` during the physical product attempt.

## Renter path

Public discovery is now served from `/rental/listings` and returns the exact selected GPU. A listing is public only while its machine and exact GPU authority remain healthy.

The workspace chooser uses `/rental/listings/:listingId/workspaces`; compatibility aliases are derived from the selected Accelerator, not from the Machine GPU summary.

Legacy machine-level publication is rejected with HTTP 410. Product-level booking rejects non-`SELECTED_ACCELERATORS` listings. The low-level allocation service retains legacy mode support for architecture/migration compatibility, but the private-beta product boundary is exact-GPU only.

At allocation time the API revalidates the exact accelerator and its resource authority. A hidden/stale/quarantined/unmapped GPU therefore cannot be booked by bypassing the browser and calling `/bookings` directly.

## Owner path

Owner views use server-authoritative rental endpoints:

- `/rental/machines/manage`;
- `/rental/machines/:machineId/gpus`;
- `/rental/listings/manage`;
- `/rental/listings` for publication.

The owner UI displays exact GPU identity, health, resource runtime state, public visibility and current booking information.

## Listing lifecycle

Two owner lifecycle states are explicit in Prisma and PostgreSQL:

- `PAUSED`: owner intentionally stops new marketplace bookings without overloading offline/security state;
- `ARCHIVED`: terminal owner lifecycle state; archived listings no longer reserve the accelerator listing identity.

Owner actions are transactional:

- pause: `ACTIVE`, `RESERVED` or `HIDDEN_OFFLINE` -> `PAUSED`; an already committed rental is not cancelled;
- resume: `PAUSED` -> `ACTIVE` only when machine presence and exact GPU authority are healthy;
- archive: allowed only when no committed/non-terminal booking remains;
- security `SUSPENDED` listings cannot be owner-resumed or owner-archived through this lifecycle.

Paused listings continue to own the exact accelerator, preventing duplicate adverts. Archived listings do not.

A healthy heartbeat can automatically recover only `HIDDEN_OFFLINE` exact-GPU listings back to `ACTIVE`. `PAUSED`, `ARCHIVED`, security-suspended and verification-pending states are never auto-reactivated.

## Test coverage added

Coverage includes:

- centralized machine rental readiness;
- exact GPU publication readiness and blocking reasons;
- exact public marketplace health;
- exact GPU allocation revalidation;
- missing/stale/quarantined resource authority;
- duplicate/allocated GPU publication prevention;
- legacy publication/booking guards through real `Fastify.inject()` routing;
- owner machine/listing UI route contracts;
- full Agent-side GPU_PROOF orchestration remains covered by the prior qualified stack;
- offline listing recovery;
- owner pause/resume/archive lifecycle invariants;
- JavaScript syntax gates for publish, renter workspace chooser and owner rental UI.

## Separate security blocker

Repository issue tracking `GHSA-ggr8-5vv4-36mx` covers the existing Prisma tooling dependency chain:

`prisma 6.19.3 -> @prisma/config 6.19.3 -> deepmerge-ts 7.1.5`.

The rental PR did not introduce this dependency. A hand-edited lockfile, CI suppression or unqualified major Prisma upgrade is explicitly not accepted as remediation. The security issue requires deterministic lock regeneration / supported dependency upgrade and full regression gates.

## Physical qualification status

This software work does **not** change the product-level qualification status by itself.

Previously proven evidence remains separate:

- authenticated direct QUIC on LAN;
- authenticated direct QUIC between two physical machines on different Internet access networks, no relay;
- physical GTX 1650 execution of the immutable GPU proof runner with cleanup.

A fresh physical renter-to-host marketplace E2E is still required after an exact qualified build is published and deployed. It must capture exact listing publication, booking, Compute session creation, GPU_PROOF claim, physical CUDA execution, signed workload metrics, completion/finalization, allocation release, machine availability and renter terminal UI.

Until then, the full marketplace product E2E remains **NOT QUALIFIED**.
