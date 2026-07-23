import test from 'node:test';
import assert from 'node:assert/strict';
import { JobStatus } from '@prisma/client';
import { canTransitionJob, terminalJobStatuses } from '../src/job-state.js';

test('allows the diagnostic happy path', () => {
  const path = [JobStatus.QUEUED, JobStatus.ASSIGNED, JobStatus.PREPARING, JobStatus.RUNNING, JobStatus.UPLOADING_RESULTS, JobStatus.COMPLETED];
  for (let index = 1; index < path.length; index += 1) {
    assert.equal(canTransitionJob(path[index - 1], path[index]), true);
  }
});

test('terminal statuses cannot transition', () => {
  for (const status of terminalJobStatuses) {
    assert.equal(canTransitionJob(status, JobStatus.RUNNING), false);
  }
});

test('cannot skip directly from queued to running', () => {
  assert.equal(canTransitionJob(JobStatus.QUEUED, JobStatus.RUNNING), false);
});
