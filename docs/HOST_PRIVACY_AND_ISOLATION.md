# GPUbnb Host privacy and renter-isolation contract

This document fixes the privacy boundary that GPUbnb must preserve while a privately owned machine is made available to renters. It describes guarantees backed by the current architecture separately from requirements that still need physical or release qualification.

## Owner data boundary

A renter session is not an interactive login to the owner's Windows account and is not permitted to browse the owner's filesystem. Workspace persistence is scoped to the per-session Docker volume created for that Workspace. GPUbnb must not add host-directory bind mounts for user profiles, Desktop, Documents, Downloads, browser profiles, credential stores, SSH directories, cloud-sync directories, removable media or arbitrary owner-selected paths to renter Workspaces.

The Docker socket and equivalent container-management control surfaces must never be mounted into a renter Workspace. The renter must never receive raw Agent signing keys, pairing/link secrets, browser cookies, API bearer tokens, owner wallet credentials, environment variables from the Host process, or local GPUbnb configuration files.

## Network boundary

The renter does not choose an arbitrary host, IP address or port behind the Host. A Workspace is reached only through the server-authorized session runtime registered for that booking.

Each session uses a dedicated internal Docker network and a dedicated proxy/runtime path. Public browser access terminates at GPUbnb's authenticated gateway/relay boundary; an arbitrary Host LAN destination must not be accepted as a renter-controlled upstream target.

Any future direct/QUIC transport must preserve the same rule: direct transport may change the byte path but must not expand the set of reachable local destinations.

## Runtime boundary

The standard Workspace profile remains non-root where supported, read-only where the image supports it, capability-dropped, `no-new-privileges`, without a Docker socket, and with only the Workspace project volume writable. Images that currently require a reduced profile are an explicitly documented exception and must not be described as having stronger isolation than they actually have.

A release must not claim VM-level isolation while the production runtime is container-based. Stronger VM isolation may be introduced later, but only after implementation and qualification.

## Renter-visible Host data

Public/renter surfaces should expose only information needed to evaluate the rental, for example verified accelerator model, VRAM, driver/runtime compatibility, availability/readiness and coarse service-quality facts. They must not expose:

- owner account identity unless the owner explicitly chooses a public identity feature;
- Windows username, hostname or local account names;
- exact street address or precise physical location;
- LAN/private/public IP addresses;
- motherboard/BIOS/drive serial numbers or other unnecessary stable device identifiers;
- full internal machine IDs, Agent public-key fingerprints or raw hardware UUIDs when a shorter/non-sensitive presentation is sufficient;
- local paths, filenames, process command lines or environment variables unrelated to rental readiness.

If geographic information is introduced for latency discovery, it must be coarse enough for service selection and must not silently become precise-location disclosure.

## Support and diagnostics

The one-click support report is a deliberately curated report, not a raw log bundle. Its schema must remain allowlist-based. It may include operational readiness, versions, compatibility/recovery reason codes and shortened correlation identifiers, but must exclude secrets, user files, full paths, cookies, tokens, keys, wallet material, environment variables and raw log contents by default.

Raw Agent logs can contain operational identifiers and therefore are not automatically attached to support reports. Any future log-upload workflow must define redaction, retention, access control and explicit owner consent before upload.

## Local identity and removal

Normal upgrade/repair must preserve Host identity and configuration. Normal uninstall may preserve the GPUbnb data directory so an accidental uninstall does not silently destroy cryptographic identity or audit continuity.

A future destructive "remove my GPUbnb data" action must be explicit and separate from ordinary uninstall. It must coordinate server-side unlink/revocation before claiming the Host identity has been removed everywhere. It must not delete arbitrary Docker/user data outside resources owned by GPUbnb.

## Retention requirements

Before public real-money use, every server-side diagnostic/telemetry class must have a documented retention purpose and bounded retention policy. Security/audit evidence that is legally or operationally required may have a different retention window from transient debugging data; those classes must remain distinguishable rather than sharing an unbounded generic log store.

## Release qualification invariants

A candidate may not weaken the following without an explicit security review and new qualification evidence:

1. no renter-controlled Host/LAN target;
2. no Docker socket in renter Workspaces;
3. no owner filesystem bind mount into renter Workspaces;
4. per-session runtime/storage/network identity and verified cleanup;
5. booking/session-scoped access authority;
6. support-report allowlist with secret/path/log exclusion;
7. no claim of VM isolation unless a VM boundary actually exists.

The frozen physical baseline remains a rollback/reference point; privacy hardening must be developed on isolated branches and requalified before promotion.