import assert from 'node:assert/strict';
import test from 'node:test';
import { JobStatus } from '@prisma/client';

import {
  createJobLeaseToken,
  hashJobLeaseToken,
  jobLeaseExpiresAt,
  jobLeaseWhere,
  supportsJobLeaseProtocol,
  terminalAttemptMatches,
} from '../src/job-execution-lease.js';

const NOW = new Date('2026-08-12T00:00:00.000Z');

test('lease tokens are opaque fixed-size capabilities and only hashes are compared', () => {
  const first = createJobLeaseToken();
  const second = createJobLeaseToken();
  assert.equal(first.length, 43);
  assert.equal(second.length, 43);
  assert.notEqual(first, second);
  assert.match(hashJobLeaseToken(first), /^[a-f0-9]{64}$/);
  assert.notEqual(hashJobLeaseToken(first), first);
});

test('lease deadline has a 30 second safety floor', () => {
  assert.equal(jobLeaseExpiresAt(NOW, 1).toISOString(), '2026-08-12T00:00:30.000Z');
  assert.equal(jobLeaseExpiresAt(NOW, 45).toISOString(), '2026-08-12T00:00:45.000Z');
});

test('active lease predicate binds job, machine, attempt, token and expiry', () => {
  const where = jobLeaseWhere({
    jobId: 'job-1',
    machineId: 'machine-1',
    credentials: { attemptId: 'attempt-2', leaseToken: 'x'.repeat(43) },
    now: NOW,
  }) as any;
  assert.equal(where.id, 'job-1');
  assert.equal(where.machineId, 'machine-1');
  assert.equal(where.currentAttemptId, 'attempt-2');
  assert.equal(where.leaseTokenHash, hashJobLeaseToken('x'.repeat(43)));
  assert.equal(where.leaseExpiresAt.gt, NOW);
  assert.ok(where.status.in.includes(JobStatus.ASSIGNED));
  assert.ok(where.status.in.includes(JobStatus.UPLOADING_RESULTS));
});

test('terminal idempotence only accepts the same fenced attempt', () => {
  const token = 'a'.repeat(43);
  assert.equal(terminalAttemptMatches({
    currentAttemptId: 'attempt-1',
    leaseTokenHash: hashJobLeaseToken(token),
    credentials: { attemptId: 'attempt-1', leaseToken: token },
  }), true);
  assert.equal(terminalAttemptMatches({
    currentAttemptId: 'attempt-2',
    leaseTokenHash: hashJobLeaseToken(token),
    credentials: { attemptId: 'attempt-1', leaseToken: token },
  }), false);
});

test('qualified job protocol is fail-closed for pre-0.6.2 or malformed agents', () => {
  assert.equal(supportsJobLeaseProtocol('0.5.5'), false);
  assert.equal(supportsJobLeaseProtocol('0.6.0'), false);
  // 0.6.1 predates the exact-GPU-by-hardwareUuid fix (runner.py's gpu_proof_command
  // no longer defaults to --gpus=device=0) and must now be rejected the same way
  // 0.6.0 was rejected for predating the pinned proof image fix.
  assert.equal(supportsJobLeaseProtocol('0.6.1'), false);
  assert.equal(supportsJobLeaseProtocol('0.6.2'), true);
  assert.equal(supportsJobLeaseProtocol('0.7.0-beta.1'), true);
  assert.equal(supportsJobLeaseProtocol('garbage'), false);
  assert.equal(supportsJobLeaseProtocol(null), false);
});
