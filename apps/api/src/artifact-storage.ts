import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ARTIFACT_KIND_RE = /^[A-Za-z0-9._-]{1,32}$/;
const ARTIFACT_SHA256_RE = /^[a-f0-9]{64}$/;
const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class ArtifactStorageError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ArtifactStorageError';
  }
}

export function validateArtifactKind(kind: string): string {
  if (!ARTIFACT_KIND_RE.test(kind) || kind === '.' || kind === '..') {
    throw new ArtifactStorageError('invalid_artifact_kind');
  }
  return kind;
}

export function buildArtifactObjectKey(jobId: string, kind: string, sha256: string): string {
  if (!ARTIFACT_ID_RE.test(jobId)) throw new ArtifactStorageError('invalid_artifact_job_id');
  validateArtifactKind(kind);
  if (!ARTIFACT_SHA256_RE.test(sha256)) throw new ArtifactStorageError('invalid_artifact_sha256');
  return `${jobId}/${kind}/${sha256}`;
}

function decodeFilesystemStorageKey(storageKey: string): string {
  if (storageKey.startsWith('fs:')) return storageKey.slice(3);
  // Backwards compatibility: artifacts written before backend-aware keys were
  // introduced used the raw relative object key directly.
  if (!storageKey.includes(':')) return storageKey;
  throw new ArtifactStorageError('unsupported_artifact_storage_backend');
}

export class FilesystemArtifactStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private resolveObjectKey(objectKey: string): string {
    if (!objectKey || path.isAbsolute(objectKey) || objectKey.includes('\0')) {
      throw new ArtifactStorageError('invalid_artifact_storage_key');
    }
    const resolved = path.resolve(this.root, objectKey);
    const prefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (resolved !== this.root && !resolved.startsWith(prefix)) {
      throw new ArtifactStorageError('artifact_path_escape');
    }
    return resolved;
  }

  async write(jobId: string, kind: string, sha256: string, data: Buffer): Promise<string> {
    const objectKey = buildArtifactObjectKey(jobId, kind, sha256);
    const filePath = this.resolveObjectKey(objectKey);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, data);
    return `fs:${objectKey}`;
  }

  async read(storageKey: string): Promise<Buffer> {
    const objectKey = decodeFilesystemStorageKey(storageKey);
    return fsp.readFile(this.resolveObjectKey(objectKey));
  }
}
