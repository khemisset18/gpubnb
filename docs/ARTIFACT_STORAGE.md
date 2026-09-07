# GPUbnb artifact storage architecture

Last audited: 2026-09-07.

## Current responsibility

Job artifacts are uploaded by an authenticated GPU host after execution and downloaded by the renter through the API. The database stores artifact metadata (`jobId`, `kind`, `sha256`, `sizeBytes`, `storageKey`), while the bytes themselves are stored outside PostgreSQL.

## Security invariants

Artifact storage must preserve all of these invariants:

1. `kind` is one safe path segment only: `[A-Za-z0-9._-]{1,32}`, excluding `.` and `..`.
2. `sha256` is exactly 64 lowercase hexadecimal characters and is verified against the uploaded bytes before storage.
3. A storage key must never be allowed to escape the configured storage root.
4. The renter must still own the job before artifact bytes are returned.
5. Uploads remain authenticated with the signed agent request protocol.
6. Existing legacy unprefixed storage keys must remain readable during migration.
7. New backends must never silently reinterpret a key belonging to a different backend.
8. An S3 key must name the exact configured bucket; cross-bucket reads fail closed.
9. Object-storage credentials are server-only and must never be exposed to the browser or host agent.

The filesystem backend resolves every object key against an absolute root and rejects path traversal before touching the filesystem. The S3 backend uses only deterministic object keys generated from validated `jobId`, `kind` and SHA-256 values.

## Backend-aware storage keys

New filesystem objects use:

```text
fs:<jobId>/<kind>/<sha256>
```

S3-compatible objects use:

```text
s3:<bucket>/<jobId>/<kind>/<sha256>
```

Artifacts created before backend-aware keys used the raw relative form:

```text
<jobId>/<kind>/<sha256>
```

Those legacy keys are treated as filesystem keys for backwards compatibility. Unknown prefixes fail closed.

## Implemented backends

`FilesystemArtifactStorage` remains the default for local development, CI and rollback compatibility.

`S3ArtifactStorage` is implemented with the AWS S3 client and `forcePathStyle: true`, so it can target provider-neutral S3-compatible services. Supabase Storage is the intended production target using an endpoint of the form:

```text
https://<project-ref>.storage.supabase.co/storage/v1/s3
```

The API keeps authorization in GPUbnb itself. The browser never receives S3 access keys and does not read the bucket directly.

`RoutedArtifactStorage` selects the write backend while routing reads by the stored prefix. This allows new writes to move to S3 while old `fs:` and legacy unprefixed artifacts remain readable from the filesystem during migration.

## Configuration

Local/default configuration:

```text
ARTIFACT_STORAGE_BACKEND=filesystem
FILE_STORAGE_DIR=./data/artifacts
```

S3-compatible production configuration:

```text
ARTIFACT_STORAGE_BACKEND=s3
ARTIFACT_S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
ARTIFACT_S3_REGION=local
ARTIFACT_S3_BUCKET=gpubnb-artifacts
ARTIFACT_S3_ACCESS_KEY_ID=<server-only access key>
ARTIFACT_S3_SECRET_ACCESS_KEY=<server-only secret key>
```

If `ARTIFACT_STORAGE_BACKEND=s3`, startup fails closed when endpoint, bucket, access key or secret key is missing. The configured bucket name is embedded in each S3 storage key and verified again on reads.

## Production target

Local filesystem storage is acceptable for development, CI and a single durable host with an explicitly managed persistent volume. It is not the final production architecture for a horizontally scaled or ephemeral API runtime because:

- a redeploy may lose local files;
- two replicas may see different local disks;
- failover to another instance can make metadata exist while bytes are unavailable;
- backups and retention are harder to reason about than object storage.

The production target is a private Supabase Storage bucket through its S3-compatible endpoint. The storage abstraction remains provider-neutral so GPUbnb is not coupled to a proprietary object API.

## Safe migration and cutover

1. Keep `ARTIFACT_STORAGE_BACKEND=filesystem` while creating the private object bucket and server-only S3 credentials.
2. Verify the API can `PutObject` and `GetObject` in a non-production probe path with the exact production endpoint and bucket.
3. Inventory every `JobArtifact` whose key is legacy/unprefixed or `fs:`.
4. For every historical object, read local bytes and verify the database SHA-256 and byte count before copy.
5. Upload to S3 using the deterministic object key and read it back.
6. Verify the downloaded S3 bytes match both the recorded SHA-256 and byte count.
7. Only after verification, rewrite that artifact metadata to its `s3:<bucket>/...` key. Migration must be resumable and idempotent.
8. When historical verification is complete, set `ARTIFACT_STORAGE_BACKEND=s3` so all new writes are durable object writes.
9. Keep the filesystem available during the observation window so rollback can still read old `fs:` keys.
10. Remove dependency on production filesystem storage only after a database audit proves no legacy/unprefixed or `fs:` metadata remains.

Never bulk-rewrite database storage keys before the corresponding object has been copied and verified.

## Rollback model

Changing the write backend does not change historical read routing. While both backends are configured, `RoutedArtifactStorage` reads `s3:` from S3 and `fs:`/legacy from disk. This means a failed write cutover can be stopped without corrupting existing metadata.

A rollback must never reinterpret an `s3:` key as a filesystem path. If S3 is unavailable or not configured, S3-prefixed artifacts fail closed instead of silently reading from another backend.

## Operational checks

For every artifact incident, record at minimum `jobId`, `artifactId`, `storageKey`, backend, expected SHA-256 and byte count. Never log artifact contents, S3 access keys or secret keys.

Before enabling S3 writes in production verify:

- bucket is private;
- endpoint is the direct Storage S3 endpoint for the intended project;
- credentials are stored only in the server secret manager;
- upload and download probes pass from the actual API runtime;
- a known test artifact survives an API redeploy;
- two API replicas can both read the same test object;
- legacy filesystem reads still pass during the migration window;
- rollback procedure and credential rotation procedure are documented for operators.

A later readiness gate should reject production filesystem writes once the historical migration evidence is complete and the object-storage cutover is declared authoritative.
