import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { FilesystemArtifactStorage, S3ArtifactStorage } from '../artifact-storage.js';
import { migrateArtifactsToS3, type ArtifactMigrationRepository } from '../artifact-storage-migration.js';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  FILE_STORAGE_DIR: z.string().default('./data/artifacts'),
  ARTIFACT_S3_ENDPOINT: z.string().url(),
  ARTIFACT_S3_REGION: z.string().min(1).default('local'),
  ARTIFACT_S3_BUCKET: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/),
  ARTIFACT_S3_ACCESS_KEY_ID: z.string().min(8),
  ARTIFACT_S3_SECRET_ACCESS_KEY: z.string().min(16),
  ARTIFACT_MIGRATION_APPLY: z.enum(['true', 'false']).default('false'),
  ARTIFACT_MIGRATION_LIMIT: z.coerce.number().int().min(1).max(10_000).default(100),
});

const env = envSchema.parse(process.env);
const db = new PrismaClient();
const repository: ArtifactMigrationRepository = {
  async listCandidates(limit) {
    return db.jobArtifact.findMany({
      where: { NOT: { storageKey: { startsWith: 's3:' } } },
      select: { id: true, jobId: true, kind: true, sha256: true, sizeBytes: true, storageKey: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
  },
  async updateStorageKeyIfUnchanged(id, oldStorageKey, newStorageKey) {
    const result = await db.jobArtifact.updateMany({
      where: { id, storageKey: oldStorageKey },
      data: { storageKey: newStorageKey },
    });
    return result.count === 1;
  },
};

const source = new FilesystemArtifactStorage(env.FILE_STORAGE_DIR);
const destination = new S3ArtifactStorage({
  endpoint: env.ARTIFACT_S3_ENDPOINT,
  region: env.ARTIFACT_S3_REGION,
  bucket: env.ARTIFACT_S3_BUCKET,
  accessKeyId: env.ARTIFACT_S3_ACCESS_KEY_ID,
  secretAccessKey: env.ARTIFACT_S3_SECRET_ACCESS_KEY,
});
const mode = env.ARTIFACT_MIGRATION_APPLY === 'true' ? 'apply' : 'dry-run';

try {
  console.log(JSON.stringify({ event: 'artifact_migration_start', mode, limit: env.ARTIFACT_MIGRATION_LIMIT, bucket: env.ARTIFACT_S3_BUCKET }));
  const summary = await migrateArtifactsToS3({
    repository,
    source,
    destination,
    mode,
    limit: env.ARTIFACT_MIGRATION_LIMIT,
    onEvent: (event) => console.log(JSON.stringify({ event: 'artifact_migration_item', ...event })),
  });
  console.log(JSON.stringify({ event: 'artifact_migration_summary', mode, ...summary }));
  if (summary.failed > 0 || summary.concurrentChanged > 0) process.exitCode = 2;
} finally {
  await db.$disconnect();
}
