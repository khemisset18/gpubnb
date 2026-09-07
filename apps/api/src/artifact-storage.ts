import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const ARTIFACT_KIND_RE = /^[A-Za-z0-9._-]{1,32}$/;
const ARTIFACT_SHA256_RE = /^[a-f0-9]{64}$/;
const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ARTIFACT_BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;

export interface ArtifactStorage {
  write(jobId: string, kind: string, sha256: string, data: Buffer): Promise<string>;
  read(storageKey: string): Promise<Buffer>;
}

export class ArtifactStorageError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ArtifactStorageError';
  }
}

export function validateArtifactKind(kind: string): string {
  if (!ARTIFACT_KIND_RE.test(kind) || kind === '.' || kind === '..') throw new ArtifactStorageError('invalid_artifact_kind');
  return kind;
}

export function buildArtifactObjectKey(jobId: string, kind: string, sha256: string): string {
  if (!ARTIFACT_ID_RE.test(jobId)) throw new ArtifactStorageError('invalid_artifact_job_id');
  validateArtifactKind(kind);
  if (!ARTIFACT_SHA256_RE.test(sha256)) throw new ArtifactStorageError('invalid_artifact_sha256');
  return `${jobId}/${kind}/${sha256}`;
}

export function verifyArtifactBytes(data: Buffer, expectedSha256: string, expectedSizeBytes: number): void {
  if (data.length !== expectedSizeBytes) throw new ArtifactStorageError('artifact_integrity_check_failed');
  const actualSha256 = crypto.createHash('sha256').update(data).digest('hex');
  if (actualSha256 !== expectedSha256) throw new ArtifactStorageError('artifact_integrity_check_failed');
}

function decodeFilesystemStorageKey(storageKey: string): string {
  if (storageKey.startsWith('fs:')) return storageKey.slice(3);
  if (!storageKey.includes(':')) return storageKey;
  throw new ArtifactStorageError('unsupported_artifact_storage_backend');
}

function decodeS3StorageKey(storageKey: string, expectedBucket: string): string {
  if (!storageKey.startsWith('s3:')) throw new ArtifactStorageError('unsupported_artifact_storage_backend');
  const encoded = storageKey.slice(3);
  const slash = encoded.indexOf('/');
  if (slash <= 0) throw new ArtifactStorageError('invalid_artifact_storage_key');
  const bucket = encoded.slice(0, slash);
  const objectKey = encoded.slice(slash + 1);
  if (bucket !== expectedBucket) throw new ArtifactStorageError('artifact_bucket_mismatch');
  if (!objectKey || objectKey.includes('\0')) throw new ArtifactStorageError('invalid_artifact_storage_key');
  const parts = objectKey.split('/');
  if (parts.length !== 3) throw new ArtifactStorageError('invalid_artifact_storage_key');
  const [jobId, kind, sha256] = parts;
  try {
    if (buildArtifactObjectKey(jobId!, kind!, sha256!) !== objectKey) throw new ArtifactStorageError('invalid_artifact_storage_key');
  } catch (error) {
    if (error instanceof ArtifactStorageError && error.code === 'invalid_artifact_storage_key') throw error;
    throw new ArtifactStorageError('invalid_artifact_storage_key');
  }
  return objectKey;
}

export class FilesystemArtifactStorage implements ArtifactStorage {
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true }); }
  private resolveObjectKey(objectKey: string): string {
    if (!objectKey || path.isAbsolute(objectKey) || objectKey.includes('\0')) throw new ArtifactStorageError('invalid_artifact_storage_key');
    const resolved = path.resolve(this.root, objectKey);
    const prefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (resolved !== this.root && !resolved.startsWith(prefix)) throw new ArtifactStorageError('artifact_path_escape');
    return resolved;
  }
  async write(jobId: string, kind: string, sha256: string, data: Buffer): Promise<string> {
    const objectKey = buildArtifactObjectKey(jobId, kind, sha256);
    const filePath = this.resolveObjectKey(objectKey);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, data);
    return `fs:${objectKey}`;
  }
  async read(storageKey: string): Promise<Buffer> { return fsp.readFile(this.resolveObjectKey(decodeFilesystemStorageKey(storageKey))); }
}

type S3Sender = Pick<S3Client, 'send'>;
export type S3ArtifactStorageOptions = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; client?: S3Sender };

export class S3ArtifactStorage implements ArtifactStorage {
  readonly bucket: string;
  private readonly client: S3Sender;
  constructor(options: S3ArtifactStorageOptions) {
    if (!ARTIFACT_BUCKET_RE.test(options.bucket)) throw new ArtifactStorageError('invalid_artifact_bucket');
    this.bucket = options.bucket;
    this.client = options.client ?? new S3Client({ endpoint: options.endpoint, region: options.region, forcePathStyle: true, credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } });
  }
  async write(jobId: string, kind: string, sha256: string, data: Buffer): Promise<string> {
    const objectKey = buildArtifactObjectKey(jobId, kind, sha256);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: data, ContentType: 'application/octet-stream', Metadata: { sha256 } }));
    return `s3:${this.bucket}/${objectKey}`;
  }
  async read(storageKey: string): Promise<Buffer> {
    const objectKey = decodeS3StorageKey(storageKey, this.bucket);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey })) as { Body?: { transformToByteArray?: () => Promise<Uint8Array> } };
      if (!result.Body?.transformToByteArray) throw new ArtifactStorageError('artifact_object_body_missing');
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (candidate?.name === 'NoSuchKey' || candidate?.name === 'NotFound' || candidate?.$metadata?.httpStatusCode === 404) throw new ArtifactStorageError('ENOENT');
      throw error;
    }
  }
}

export class RoutedArtifactStorage implements ArtifactStorage {
  constructor(private readonly writer: ArtifactStorage, private readonly filesystem: FilesystemArtifactStorage, private readonly s3?: S3ArtifactStorage) {}
  write(jobId: string, kind: string, sha256: string, data: Buffer): Promise<string> { return this.writer.write(jobId, kind, sha256, data); }
  read(storageKey: string): Promise<Buffer> {
    if (storageKey.startsWith('s3:')) {
      if (!this.s3) throw new ArtifactStorageError('unsupported_artifact_storage_backend');
      return this.s3.read(storageKey);
    }
    return this.filesystem.read(storageKey);
  }
}
