import crypto from 'node:crypto';
import { JobStatus, type Prisma } from '@prisma/client';

export const JOB_LEASE_PROTOCOL_VERSION = '0.5.5';
export const JOB_LEASE_TOKEN_BYTES = 32;
export const JOB_LEASE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const ACTIVE_EXECUTION_STATUSES: JobStatus[] = [
  JobStatus.ASSIGNED,
  JobStatus.DOWNLOADING,
  JobStatus.PREPARING,
  JobStatus.RUNNING,
  JobStatus.UPLOADING_RESULTS,
  JobStatus.CANCEL_REQUESTED,
];

export type JobLeaseCredentials = {
  attemptId: string;
  leaseToken: string;
};

export function createJobLeaseToken(): string {
  return crypto.randomBytes(JOB_LEASE_TOKEN_BYTES).toString('base64url');
}

export function hashJobLeaseToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function jobLeaseExpiresAt(now: Date, leaseSeconds: number): Date {
  return new Date(now.getTime() + Math.max(30, leaseSeconds) * 1000);
}

export function jobLeaseWhere(input: {
  jobId: string;
  machineId: string;
  credentials: JobLeaseCredentials;
  now: Date;
}): Prisma.JobWhereInput {
  return {
    id: input.jobId,
    machineId: input.machineId,
    currentAttemptId: input.credentials.attemptId,
    leaseTokenHash: hashJobLeaseToken(input.credentials.leaseToken),
    leaseExpiresAt: { gt: input.now },
    status: { in: ACTIVE_EXECUTION_STATUSES },
  };
}

export function terminalAttemptMatches(input: {
  currentAttemptId: string | null;
  leaseTokenHash: string | null;
  credentials: JobLeaseCredentials;
}): boolean {
  if (!input.currentAttemptId || !input.leaseTokenHash) return false;
  return (
    input.currentAttemptId === input.credentials.attemptId &&
    input.leaseTokenHash === hashJobLeaseToken(input.credentials.leaseToken)
  );
}

function parseVersion(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function supportsJobLeaseProtocol(agentVersion: string | null | undefined): boolean {
  const actual = parseVersion(agentVersion);
  const required = parseVersion(JOB_LEASE_PROTOCOL_VERSION)!;
  if (!actual) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return true;
    if (actual[index] < required[index]) return false;
  }
  return true;
}
