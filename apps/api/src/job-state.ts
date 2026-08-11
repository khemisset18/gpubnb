import { JobStatus } from '@prisma/client';

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  DRAFT: [JobStatus.QUEUED, JobStatus.CANCELLED],
  QUEUED: [JobStatus.ASSIGNED, JobStatus.CANCEL_REQUESTED, JobStatus.CANCELLED, JobStatus.TIMED_OUT, JobStatus.REJECTED],
  ASSIGNED: [JobStatus.DOWNLOADING, JobStatus.PREPARING, JobStatus.CANCEL_REQUESTED, JobStatus.FAILED, JobStatus.TIMED_OUT, JobStatus.QUARANTINED],
  DOWNLOADING: [JobStatus.PREPARING, JobStatus.CANCEL_REQUESTED, JobStatus.FAILED, JobStatus.TIMED_OUT, JobStatus.QUARANTINED],
  PREPARING: [JobStatus.RUNNING, JobStatus.CANCEL_REQUESTED, JobStatus.FAILED, JobStatus.TIMED_OUT, JobStatus.QUARANTINED],
  RUNNING: [JobStatus.UPLOADING_RESULTS, JobStatus.CANCEL_REQUESTED, JobStatus.FAILED, JobStatus.TIMED_OUT, JobStatus.QUARANTINED],
  UPLOADING_RESULTS: [JobStatus.COMPLETED, JobStatus.CANCEL_REQUESTED, JobStatus.FAILED, JobStatus.QUARANTINED],
  CANCEL_REQUESTED: [JobStatus.CANCELLED, JobStatus.FAILED, JobStatus.TIMED_OUT],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
  REJECTED: [],
  QUARANTINED: [],
};

export const terminalJobStatuses = [
  JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED,
  JobStatus.TIMED_OUT, JobStatus.REJECTED, JobStatus.QUARANTINED,
] as const;

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}
