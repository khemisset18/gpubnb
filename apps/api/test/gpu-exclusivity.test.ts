import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JobStatus, JobType, ModerationStatus } from '@prisma/client';
import {
  JOB_TYPE_EXCLUSIVITY,
  GPU_OCCUPYING_JOB_STATUSES,
  isExclusiveJobType,
  gpuLockScope,
  findGpuExclusivityConflict,
} from '../src/gpu-exclusivity.js';

// RC1 risk R3: GET /agent/jobs/next/:machineId used to hand out a second job for a
// GPU that was already busy, with nothing to stop it. This is the regression suite
// for the fix — a declarative per-job-type exclusivity rule plus the shared
// conflict-detection query used at claim time in server.ts.

test('1) every current job type explicitly declares itself exclusive (none was found safe to share a GPU)', () => {
  assert.deepEqual(JOB_TYPE_EXCLUSIVITY, {
    [JobType.GPU_DIAGNOSTIC]: true,
    [JobType.WORKSPACE_PREPARE]: true,
    [JobType.GPU_PROOF]: true,
  });
  for (const type of Object.values(JobType)) assert.equal(isExclusiveJobType(type), true);
});

test('2) an unmapped job type fails closed (treated as exclusive), never silently permissive', () => {
  assert.equal(isExclusiveJobType('SOME_FUTURE_JOB_TYPE' as JobType), true);
});

test('3) QUEUED is never in the GPU-occupying status set: a merely-queued job cannot itself block a claim', () => {
  assert.equal(GPU_OCCUPYING_JOB_STATUSES.includes(JobStatus.QUEUED), false);
});

test('4) gpuLockScope prefers the reported GPU UUID over the machine id', () => {
  assert.deepEqual(gpuLockScope({ id: 'm1', gpuUuid: 'GPU-abc' }), { gpuUuid: 'GPU-abc' });
});

test('5) gpuLockScope falls back to the machine id, fail-closed, when no GPU UUID is known', () => {
  assert.deepEqual(gpuLockScope({ id: 'm1', gpuUuid: null }), { machineId: 'm1' });
});

// --- findGpuExclusivityConflict: fake Prisma tx, same in-memory pattern as
// job-staleness-sweep.test.ts. The correctness of the underlying job/machine state
// transitions is already covered elsewhere; this exercises only the exclusivity
// query's own logic (which rows count as a conflict, and why).

function fakeTx(seed: {
  jobs?: Array<{ id: string; status: JobStatus; machineId: string; gpuUuid: string | null }>;
  machines?: Array<{ id: string; gpuUuid: string | null; moderationStatus: ModerationStatus }>;
}) {
  const jobs = seed.jobs ?? [];
  const machines = seed.machines ?? [];
  const machineById = new Map(machines.map(m => [m.id, m]));

  const tx = {
    job: {
      findFirst: async ({ where }: { where: { id: { not: string }; status: { in: JobStatus[] }; machineId?: string; machine?: { gpuUuid: string } } }) => {
        const match = jobs.find(j => {
          if (j.id === where.id.not) return false;
          if (!where.status.in.includes(j.status)) return false;
          if (where.machineId !== undefined) return j.machineId === where.machineId;
          if (where.machine !== undefined) return machineById.get(j.machineId)?.gpuUuid === where.machine.gpuUuid;
          return false;
        });
        return match ? { id: match.id } : null;
      },
    },
    machine: {
      findFirst: async ({ where }: { where: { id: { not: string }; gpuUuid: string; moderationStatus: ModerationStatus } }) => {
        const match = machines.find(m => m.id !== where.id.not && m.gpuUuid === where.gpuUuid && m.moderationStatus === where.moderationStatus);
        return match ? { id: match.id } : null;
      },
    },
  };
  return tx as never;
}

test('6) a RUNNING job on the same machine blocks another claim on that machine', async () => {
  const tx = fakeTx({ jobs: [{ id: 'j1', status: JobStatus.RUNNING, machineId: 'm1', gpuUuid: null }] });
  const conflict = await findGpuExclusivityConflict(tx, 'j2', { id: 'm1', gpuUuid: null });
  assert.deepEqual(conflict, { reason: 'gpu_occupied_by_another_job', jobId: 'j1' });
});

test('7) two DIFFERENT machines reporting the same physical GPU UUID: a job on one blocks a claim on the other', async () => {
  const tx = fakeTx({
    jobs: [{ id: 'j1', status: JobStatus.PREPARING, machineId: 'mA', gpuUuid: 'GPU-shared' }],
    machines: [
      { id: 'mA', gpuUuid: 'GPU-shared', moderationStatus: ModerationStatus.CLEAR },
      { id: 'mB', gpuUuid: 'GPU-shared', moderationStatus: ModerationStatus.CLEAR },
    ],
  });
  const conflict = await findGpuExclusivityConflict(tx, 'j2', { id: 'mB', gpuUuid: 'GPU-shared' });
  assert.deepEqual(conflict, { reason: 'gpu_occupied_by_another_job', jobId: 'j1' });
});

test('8) two machines with genuinely different GPU UUIDs never block each other', async () => {
  const tx = fakeTx({
    jobs: [{ id: 'j1', status: JobStatus.RUNNING, machineId: 'mA', gpuUuid: 'GPU-A' }],
    machines: [
      { id: 'mA', gpuUuid: 'GPU-A', moderationStatus: ModerationStatus.CLEAR },
      { id: 'mB', gpuUuid: 'GPU-B', moderationStatus: ModerationStatus.CLEAR },
    ],
  });
  const conflict = await findGpuExclusivityConflict(tx, 'j2', { id: 'mB', gpuUuid: 'GPU-B' });
  assert.equal(conflict, null);
});

test('9) a terminal (COMPLETED) job never blocks a new claim: the lock is released once work actually finishes', async () => {
  const tx = fakeTx({ jobs: [{ id: 'j1', status: JobStatus.COMPLETED, machineId: 'm1', gpuUuid: null }] });
  const conflict = await findGpuExclusivityConflict(tx, 'j2', { id: 'm1', gpuUuid: null });
  assert.equal(conflict, null);
});

test('10) a job never conflicts with itself', async () => {
  const tx = fakeTx({ jobs: [{ id: 'j1', status: JobStatus.RUNNING, machineId: 'm1', gpuUuid: null }] });
  const conflict = await findGpuExclusivityConflict(tx, 'j1', { id: 'm1', gpuUuid: null });
  assert.equal(conflict, null);
});

test('11) "release only after confirmed cleanup": a quarantined sibling machine on the same GPU UUID blocks a claim even with no active job left', async () => {
  // Simulates the aftermath of an unverified-cleanup terminal job: the job itself is
  // already FAILED (no longer GPU-occupying by status), but the machine that ran it
  // was quarantined precisely because cleanup was never confirmed. A second machine
  // reporting the same physical GPU UUID must still be refused.
  const tx = fakeTx({
    jobs: [{ id: 'j1', status: JobStatus.FAILED, machineId: 'mA', gpuUuid: 'GPU-shared' }],
    machines: [
      { id: 'mA', gpuUuid: 'GPU-shared', moderationStatus: ModerationStatus.QUARANTINED },
      { id: 'mB', gpuUuid: 'GPU-shared', moderationStatus: ModerationStatus.CLEAR },
    ],
  });
  const conflict = await findGpuExclusivityConflict(tx, 'j2', { id: 'mB', gpuUuid: 'GPU-shared' });
  assert.deepEqual(conflict, { reason: 'gpu_shares_a_quarantined_machine', machineId: 'mA' });
});

test('12) a quarantined machine with a different GPU UUID never blocks an unrelated machine', async () => {
  const tx = fakeTx({
    machines: [
      { id: 'mA', gpuUuid: 'GPU-A', moderationStatus: ModerationStatus.QUARANTINED },
      { id: 'mB', gpuUuid: 'GPU-B', moderationStatus: ModerationStatus.CLEAR },
    ],
  });
  const conflict = await findGpuExclusivityConflict(tx, 'j2', { id: 'mB', gpuUuid: 'GPU-B' });
  assert.equal(conflict, null);
});

test('13) with no GPU UUID known (fail-closed, per-machine scope), an unrelated machine is never checked for quarantine', async () => {
  const tx = fakeTx({
    jobs: [{ id: 'j1', status: JobStatus.RUNNING, machineId: 'mA', gpuUuid: null }],
    machines: [{ id: 'mA', gpuUuid: null, moderationStatus: ModerationStatus.QUARANTINED }],
  });
  // mB has no gpuUuid either; without a proven shared physical identity, mB's claim
  // must be evaluated purely on its own machineId scope, never merged with mA's.
  const conflict = await findGpuExclusivityConflict(tx, 'j2', { id: 'mB', gpuUuid: null });
  assert.equal(conflict, null);
});

test('14) a QUEUED job on the same machine never blocks another claim (it has not started using the GPU yet)', async () => {
  const tx = fakeTx({ jobs: [{ id: 'j1', status: JobStatus.QUEUED, machineId: 'm1', gpuUuid: null }] });
  const conflict = await findGpuExclusivityConflict(tx, 'j2', { id: 'm1', gpuUuid: null });
  assert.equal(conflict, null);
});

// --- Route wiring: the exclusivity check is only a real guarantee if the claim
// route actually runs it under Serializable isolation with retry (otherwise two
// concurrent polls racing on the same GPU scope could both pass a ReadCommitted
// check before either writes). Same source-inspection style as the existing C7
// test in workspace-preparation-race-safety.test.ts.

test('15) the job-claim route checks GPU exclusivity for exclusive job types before assigning', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const routeStart = source.indexOf("app.get('/agent/jobs/next/:machineId'");
  assert.ok(routeStart >= 0, 'route not found');
  const routeEnd = source.indexOf('\napp.', routeStart + 10);
  const routeBody = source.slice(routeStart, routeEnd);

  assert.ok(routeBody.includes('isExclusiveJobType(candidate.type)'), 'must gate the exclusivity check on the job type\'s own declared need');
  assert.ok(routeBody.includes('findGpuExclusivityConflict('), 'must run the shared conflict check before assigning');
  assert.ok(
    routeBody.includes('isolationLevel:Prisma.TransactionIsolationLevel.Serializable'),
    'the check-then-claim transaction must be Serializable, or two concurrent polls on the same GPU scope could both pass the check before either writes',
  );
  assert.ok(routeBody.includes('runBookingTransaction('), 'must retry on a genuine serialization conflict rather than surfacing a 500 to the agent');
});
