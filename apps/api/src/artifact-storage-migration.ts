import type { ArtifactStorage } from './artifact-storage.js';
import { ArtifactStorageError, verifyArtifactBytes } from './artifact-storage.js';

export type ArtifactMigrationRow = {
  id: string;
  jobId: string;
  kind: string;
  sha256: string;
  sizeBytes: number;
  storageKey: string;
};

export interface ArtifactMigrationRepository {
  listCandidates(limit: number): Promise<ArtifactMigrationRow[]>;
  updateStorageKeyIfUnchanged(id: string, oldStorageKey: string, newStorageKey: string): Promise<boolean>;
}

export type ArtifactMigrationMode = 'dry-run' | 'apply';

export type ArtifactMigrationEvent = {
  artifactId: string;
  jobId: string;
  oldStorageKey: string;
  newStorageKey?: string;
  status: 'planned' | 'updated' | 'skipped_s3' | 'concurrent_change' | 'failed';
  errorCode?: string;
};

export type ArtifactMigrationSummary = {
  scanned: number;
  planned: number;
  copied: number;
  verified: number;
  updated: number;
  skippedS3: number;
  concurrentChanged: number;
  failed: number;
};

export type ArtifactMigrationOptions = {
  repository: ArtifactMigrationRepository;
  source: ArtifactStorage;
  destination: ArtifactStorage;
  mode?: ArtifactMigrationMode;
  limit?: number;
  onEvent?: (event: ArtifactMigrationEvent) => void;
};

function errorCode(error: unknown): string {
  if (error instanceof ArtifactStorageError) return error.code;
  if (error instanceof Error) return error.name || 'error';
  return 'unknown_error';
}

export function isFilesystemMigrationCandidate(storageKey: string): boolean {
  return storageKey.startsWith('fs:') || !storageKey.includes(':');
}

export async function migrateArtifactsToS3(options: ArtifactMigrationOptions): Promise<ArtifactMigrationSummary> {
  const mode = options.mode ?? 'dry-run';
  const limit = Math.max(1, Math.min(options.limit ?? 100, 10_000));
  const rows = await options.repository.listCandidates(limit);
  const summary: ArtifactMigrationSummary = {
    scanned: rows.length,
    planned: 0,
    copied: 0,
    verified: 0,
    updated: 0,
    skippedS3: 0,
    concurrentChanged: 0,
    failed: 0,
  };

  for (const row of rows) {
    if (row.storageKey.startsWith('s3:')) {
      summary.skippedS3 += 1;
      options.onEvent?.({ artifactId: row.id, jobId: row.jobId, oldStorageKey: row.storageKey, status: 'skipped_s3' });
      continue;
    }
    if (!isFilesystemMigrationCandidate(row.storageKey)) {
      summary.failed += 1;
      options.onEvent?.({ artifactId: row.id, jobId: row.jobId, oldStorageKey: row.storageKey, status: 'failed', errorCode: 'unsupported_artifact_storage_backend' });
      continue;
    }

    try {
      const sourceBytes = await options.source.read(row.storageKey);
      verifyArtifactBytes(sourceBytes, row.sha256, row.sizeBytes);
      summary.verified += 1;

      if (mode === 'dry-run') {
        summary.planned += 1;
        options.onEvent?.({ artifactId: row.id, jobId: row.jobId, oldStorageKey: row.storageKey, status: 'planned' });
        continue;
      }

      const newStorageKey = await options.destination.write(row.jobId, row.kind, row.sha256, sourceBytes);
      summary.copied += 1;
      const destinationBytes = await options.destination.read(newStorageKey);
      verifyArtifactBytes(destinationBytes, row.sha256, row.sizeBytes);
      summary.verified += 1;

      const updated = await options.repository.updateStorageKeyIfUnchanged(row.id, row.storageKey, newStorageKey);
      if (!updated) {
        summary.concurrentChanged += 1;
        options.onEvent?.({ artifactId: row.id, jobId: row.jobId, oldStorageKey: row.storageKey, newStorageKey, status: 'concurrent_change' });
        continue;
      }
      summary.updated += 1;
      options.onEvent?.({ artifactId: row.id, jobId: row.jobId, oldStorageKey: row.storageKey, newStorageKey, status: 'updated' });
    } catch (error) {
      summary.failed += 1;
      options.onEvent?.({ artifactId: row.id, jobId: row.jobId, oldStorageKey: row.storageKey, status: 'failed', errorCode: errorCode(error) });
    }
  }

  return summary;
}
