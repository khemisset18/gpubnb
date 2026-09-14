# GPUbnb Host — privacy and isolation contract

## Purpose

A GPUbnb owner must be able to understand what a renter receives access to without reading implementation details. The renter receives access to the booking-scoped GPUbnb Workspace only. A rental is not remote-desktop access to the owner's Windows session.

## What the renter may access

During an authorized rental, GPUbnb may expose only resources explicitly attached to the booking-scoped Workspace runtime, including:

- the allocated GPU/accelerator capability;
- the Workspace filesystem/volume created for that session;
- the Workspace application's own network endpoints that the GPUbnb gateway/tunnel explicitly maps for that session;
- CPU/RAM/disk/network resources granted to the isolated runtime according to policy.

All access remains scoped by server authority, session identity and the runtime/gateway rules for that booking.

## What the renter must not receive

A renter must not receive arbitrary access to:

- the owner's Windows desktop/session;
- personal files outside the Workspace volume;
- browser profiles, cookies, passwords or account sessions;
- GPUbnb Agent private keys or signing material;
- arbitrary host processes;
- arbitrary host filesystem paths;
- arbitrary LAN devices/services;
- owner wallet or mining-pool credentials;
- exact owner address/location;
- unrelated Docker containers, volumes or networks.

A Workspace or tunnel feature that would expose one of those resources must be treated as a security change and reviewed explicitly, not enabled as a convenience fallback.

## Network boundary

GPUbnb Host initiates authenticated outbound control/data connectivity. Booking-scoped gateway/tunnel routing must target only approved local Workspace endpoints. It must never become a general-purpose TCP proxy to the host or LAN.

Opening an arbitrary inbound router port is not part of the normal Host contract.

## Local data

Persistent GPUbnb Host identity/configuration is stored under the protected GPUbnb data directory. Upgrade/repair and normal uninstall preserve that identity by design. Destructive local-data removal is a separate explicit owner action because deleting the local key means the machine must be linked again and server-side revocation/unlink semantics must remain coherent.

Support procedures must never use manual ProgramData deletion as a generic repair technique.

## Diagnostics and support exports

The copyable support report is allowlisted. It may contain operational facts such as:

- OS/architecture;
- Host lifecycle/readiness booleans;
- Agent/service status;
- GPU model, driver and VRAM;
- pass/fail readiness check identifiers;
- shortened machine/GPU references sufficient for support correlation.

It must not export account identity, pairing URL, wallet/pool configuration, filesystem paths, environment variables, cookies, bearer tokens, private/public signing keys or full machine/GPU identifiers.

The implementation contract lives in `apps/host-desktop/src/support-report.ts` and is pinned by automated privacy tests.

## Logs and telemetry

Operational logs may record stable event names, bounded error categories, timing metadata and truncated/correlated identifiers required to debug the platform. They must not log renter frame contents, authorization headers, cookies, private keys, passwords or payment secrets.

Retention/purge duration is a product/deployment policy and must be documented before broad production use. This document defines the data boundary, not an unverified retention promise.

## Isolation failure behavior

When GPUbnb cannot prove the required runtime/storage/network isolation, the Host must remain fail-closed for publication or rental. It must not silently downgrade to direct host access, broad filesystem mounting or unrestricted LAN access.

## Owner-facing promise

The simple product statement is:

> A renter receives the isolated GPUbnb Workspace attached to their booking — not your Windows desktop, personal files, passwords or home network.

That statement is valid only while the technical isolation/security gates continue to pass; GPUbnb must surface an action-required state instead of pretending otherwise when they do not.
