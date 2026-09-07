# GPUbnb historical artifact migration runbook

Last audited: 2026-09-07.

This runbook migrates historical `JobArtifact` objects from the legacy filesystem backend to the configured private S3-compatible bucket. Supabase Storage is the intended production target, but the migration engine is provider-neutral.

## Safety properties

The migration is deliberately conservative:

- dry-run is the default; `ARTIFACT_MIGRATION_APPLY=true` is required to write S3 or update PostgreSQL;
- only legacy unprefixed keys and `fs:` keys are migration candidates;
- `s3:` rows are skipped as already migrated;
- unknown backend prefixes fail closed;
- source bytes must match the database SHA-256 and byte count before copy;
- destination bytes are read back and must match the same SHA-256 and byte count before metadata changes;
- the database update is conditional on both artifact ID and the original `storageKey`, so a concurrent metadata change is never overwritten;
- deterministic destination keys make retries idempotent;
- source files are never deleted by this migration;
- failures and concurrent changes produce a non-zero process exit code.

## Required environment

The CLI reads only the database, filesystem, S3 and migration settings it needs. It does not require the full API runtime configuration.

```text
DATABASE_URL=<production PostgreSQL URL>
FILE_STORAGE_DIR=<current artifact filesystem root>
ARTIFACT_S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
ARTIFACT_S3_REGION=local
ARTIFACT_S3_BUCKET=gpubnb-artifacts
ARTIFACT_S3_ACCESS_KEY_ID=<server-only access key>
ARTIFACT_S3_SECRET_ACCESS_KEY=<server-only secret key>
ARTIFACT_MIGRATION_LIMIT=100
ARTIFACT_MIGRATION_APPLY=false
```

Never put S3 access keys in browser configuration, Netlify public variables, agent configuration, screenshots, tickets or logs.

## Phase 1 — preflight

Before touching metadata:

1. confirm the bucket is private;
2. confirm the endpoint belongs to the intended Supabase project;
3. confirm the API runtime can perform a real S3 `PutObject`/`GetObject` round trip;
4. take a database backup or verified recovery point;
5. confirm `FILE_STORAGE_DIR` points to the durable filesystem containing the historical artifact bytes;
6. keep filesystem reads available throughout the migration and observation window.

## Phase 2 — dry-run

Dry-run verifies source objects and reports planned work without writing S3 and without changing PostgreSQL.

```bash
cd apps/api
ARTIFACT_MIGRATION_APPLY=false npm run artifacts:migrate:s3
```

Expected summary fields:

- `scanned`: rows examined in this batch;
- `planned`: source objects that passed integrity verification and are ready to migrate;
- `copied`: destination writes performed; must be `0` in dry-run;
- `verified`: integrity checks completed;
- `updated`: database rows changed; must be `0` in dry-run;
- `skippedS3`: already migrated rows;
- `concurrentChanged`: rows changed by another process before the conditional update;
- `failed`: missing/corrupt/unsupported rows.

Do not enter apply mode while `failed > 0` in dry-run. Investigate each artifact ID and storage key first.

## Phase 3 — apply in bounded batches

Start with a small batch:

```bash
cd apps/api
ARTIFACT_MIGRATION_LIMIT=25 ARTIFACT_MIGRATION_APPLY=true npm run artifacts:migrate:s3
```

For each successful row the tool performs, in order:

1. read local bytes;
2. verify local SHA-256 and byte count;
3. write deterministic S3 object;
4. read S3 object back;
5. verify S3 SHA-256 and byte count;
6. update `JobArtifact.storageKey` only if it still equals the original key.

Repeat the command until no non-S3 candidates remain. The process is restartable after interruption because successfully migrated rows now start with `s3:` and are excluded from later candidate batches.

If the process exits with code `2`, inspect the summary and item events. Do not increase the batch size until failures or concurrent changes are understood.

## Phase 4 — post-migration audit

Before changing the production write backend or deleting any local bytes, verify PostgreSQL contains zero remaining historical filesystem references:

```sql
SELECT COUNT(*) AS remaining_filesystem_artifacts
FROM "JobArtifact"
WHERE "storageKey" NOT LIKE 's3:%';
```

Also investigate unknown prefixes explicitly:

```sql
SELECT "storageKey", COUNT(*)
FROM "JobArtifact"
WHERE "storageKey" LIKE '%:%'
  AND "storageKey" NOT LIKE 'fs:%'
  AND "storageKey" NOT LIKE 's3:%'
GROUP BY "storageKey";
```

A zero count proves metadata migration completeness; it does not by itself prove object durability. Run read probes from the actual API runtime and from every active replica.

## Phase 5 — cutover

Only after the migration audit and live probes are green:

```text
ARTIFACT_STORAGE_BACKEND=s3
```

Redeploy the API and prove:

1. a new agent upload creates an `s3:` key;
2. the renter can download it through the authenticated GPUbnb API;
3. SHA-256 and size verification pass on download;
4. the same object remains readable after an API restart/redeploy;
5. a second API replica can read the same object.

## Rollback

If new S3 writes must be stopped, set the write backend back to `filesystem` only while the legacy filesystem is still durable and available. Historical read routing remains prefix-aware: `s3:` objects are never reinterpreted as local paths.

Do not rewrite `s3:` metadata back to `fs:` unless the corresponding filesystem bytes have separately been restored and verified. A configuration rollback is safer than a metadata rollback.

## Decommissioning local artifact storage

Local bytes may be removed only after all of the following are true:

- the database audit reports zero legacy/unprefixed and zero `fs:` rows;
- all API replicas use the S3 backend for new writes;
- a defined observation window has passed without object-read failures;
- object-storage backup/retention policy is verified;
- a restore test has been performed;
- the operator has retained the migration logs and summary as deployment evidence.

The migration CLI intentionally never deletes source files. Deletion requires a separate, explicitly reviewed retention operation.
