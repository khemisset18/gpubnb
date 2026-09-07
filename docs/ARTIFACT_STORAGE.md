# GPUbnb artifact storage architecture

Last audited: 2026-09-07.

## Current responsibility

Job artifacts are uploaded by an authenticated GPU host after execution and downloaded by the renter through the API. The database stores artifact metadata (`jobId`, `kind`, `sha256`, `sizeBytes`, `storageKey`), while the bytes themselves are stored outside PostgreSQL.

## Security invariants

Artifact storage must preserve all of these invariants:

1. `kind` is one safe path segment only: `[A-Za-z0-9._-]{1,32}`.
2. `sha256` is exactly 64 lowercase hexadecimal characters and is verified against the uploaded bytes before storage.
3. A storage key must never be allowed to escape the configured storage root.
4. The renter must still own the job before artifact bytes are returned.
5. Uploads remain authenticated with the signed agent request protocol.
6. Existing legacy unprefixed storage keys must remain readable during migration.
7. New backends must never silently reinterpret a key belonging to a different backend.

The filesystem backend therefore resolves every object key against an absolute root and rejects path traversal before touching the filesystem.

## Backend-aware storage keys

New filesystem objects use this format:

```text
fs:<jobId>/<kind>/<sha256>
```

Artifacts created before this migration used the raw relative key:

```text
<jobId>/<kind>/<sha256>
```

Those legacy keys are treated as filesystem keys for backwards compatibility.

Future durable backends must use an explicit prefix, for example `s3:`. Unknown prefixes fail closed instead of falling back to local disk.

## Production target

Local filesystem storage is acceptable for development, CI and a single durable host with an explicitly managed persistent volume. It is not the final production architecture for a horizontally scaled or ephemeral API runtime because:

- a redeploy may lose local files;
- two replicas may see different local disks;
- failover to another instance can make metadata exist while bytes are unavailable;
- backups and retention are harder to reason about than object storage.

The production target is provider-neutral S3-compatible object storage with private buckets, server-side credentials, checksummed writes and authenticated downloads through the GPUbnb API (or short-lived signed URLs after an explicit authorization design).

## Migration plan

1. Land the storage abstraction and path-confinement fix while keeping the filesystem backend authoritative.
2. Add an S3-compatible backend behind configuration without changing the `JobArtifact` schema.
3. Run dual-read migration: `s3:` keys go to object storage, legacy and `fs:` keys remain readable from disk.
4. Copy historical filesystem objects to object storage with SHA-256 verification.
5. Rewrite historical metadata only after every copied object verifies successfully.
6. Require durable object storage in production once migration evidence is complete.
7. Keep the filesystem backend for local development and tests.

## Operational checks

For every artifact incident, record at minimum `jobId`, `artifactId`, `storageKey`, backend, expected SHA-256 and byte count. Never log artifact contents or storage credentials.

A production readiness check should eventually fail if the API is configured for ephemeral filesystem storage without an explicitly approved persistent volume.
