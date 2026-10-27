import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceSessionStatus, type PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import {
  authorizeNativeQuarantineCleanup, nativeCleanupAuthorityRequestSchema, nativeCleanupContext,
  nativeRuntimeCleanupSchema, verifyNativeCleanupReport,
} from '../src/windows-native-quarantine-recovery.js';

const now = new Date('2026-10-27T12:00:00Z');
const machineId = 'cmachine00000000000000001';
const sessionId = 'csession00000000000000001';
const runId = 'crun000000000000000000001';
const target = { sessionId, resourceId: 'cresource0000000000000001',
  hardwareUuid: 'GPU-aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb' };
const input = { machineId, ...target, runtimeGeneration: '90' };
const report = { protocolVersion: 1 as const, ...target, fenceFloor: '90', helperStopped: true,
  gpuQuiescent: true, remainingRentalResourceIds: [] as string[], unsafeRuntimeResourceIds: [] as string[] };

function fixture() {
  const state = {
    machine: { moderationStatus: 'QUARANTINED', quarantineReasonCode: 'WORKSPACE_CLEANUP_FAILED' },
    run: { status: 'RUNNING', triggeredBy: 'OWNER', startedAt: new Date(now.getTime() - 10_000) },
    history: true,
    event: { details: { sessionId } } as { details: unknown } | null,
    selected: { id: sessionId, runtimeBackend: 'WINDOWS_NATIVE', booking: { acceleratorAllocations: [{
      accelerator: { machineId, hardwareUuid: target.hardwareUuid, vendor: 'NVIDIA',
        miningResource: { id: target.resourceId, kind: 'GPU' } },
    }] } },
    terminal: { status: WorkspaceSessionStatus.QUARANTINED, endedAt: new Date(now.getTime() - 60_000) as Date | null },
    allocation: null as { id: string } | null,
    fullMachine: null as { id: string } | null,
    liveSession: null as { id: string } | null,
    resource: { quarantined: false, runtimeState: 'IDLE', activeRentalId: null as string | null },
    fence: ['90', 0] as unknown,
  };
  let redisReads = 0;
  const db = {
    machine: { findUnique: async ({ where }: { where: { id: string } }) => {
      assert.equal(where.id, machineId); return state.machine;
    } },
    diagnosticRun: { findFirst: async ({ where }: { where: { id: string; machineId: string } }) =>
      where.id === runId && where.machineId === machineId ? state.run : null },
    machineQuarantineEvent: { findMany: async (query: { where: Record<string, unknown> }) => {
      assert.equal(query.where.machineId, machineId);
      assert.equal(query.where.resolvedAt, null);
      return state.event ? [state.event] : [];
    } },
    workspaceSession: { findMany: async (query: { where: { machineId: string; id: { in: string[] } } }) => {
      assert.equal(query.where.machineId, machineId);
      return query.where.id.in.includes(sessionId) ? [state.selected] : [];
    }, findFirst: async (query: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
      assert.equal(query.where.machineId, machineId);
      if (query.select.booking) return query.where.id === sessionId ? state.selected : null;
      if (query.select.status) return query.where.id === sessionId ? state.terminal : null;
      if (query.where.endedAt === null) return state.liveSession;
      return state.history ? { id: sessionId } : null;
    } },
    acceleratorAllocation: { findFirst: async () => state.allocation },
    machineAllocation: { findFirst: async () => state.fullMachine },
    miningResource: { findFirst: async (query: { where: { id: string; machineId: string } }) => {
      assert.deepEqual(query.where, { id: target.resourceId, machineId }); return state.resource;
    } },
  } as unknown as PrismaClient;
  const redis = { eval: async (script: string, keyCount: number, lease: string, fence: string) => {
    redisReads++;
    assert.equal(keyCount, 2);
    assert.equal(lease, `gpubnb:resource-lease:{${target.resourceId}}:v1`);
    assert.equal(fence, `gpubnb:resource-fence:{${target.resourceId}}:v1`);
    assert.doesNotMatch(script, /\b(INCR|SET|DEL|EXPIRE|HSET)\b/);
    return state.fence;
  } } as unknown as Redis;
  return { state, db, redis, redisReads: () => redisReads,
    authorize: (body = input) => authorizeNativeQuarantineCleanup(db, redis, runId, body, now) };
}

test('a fresh owner diagnostic can authorize STOP of the exact retired quarantined native session without creating a booking or fence', async () => {
  const f = fixture();
  const before = structuredClone(f.state);
  assert.deepEqual(await f.authorize(), { protocolVersion: 1, diagnosticRunId: runId, ...target, allowed: true, fenceFloor: '90' });
  assert.deepEqual(f.state, before);
  assert.equal(f.redisReads(), 1);
});

test('admin recovery is supported, but system, stale, future and completed diagnostics are refused', async () => {
  const f = fixture();
  f.state.run.triggeredBy = 'ADMIN';
  assert.equal((await f.authorize()).allowed, true);
  for (const triggeredBy of ['SYSTEM', 'unknown']) {
    f.state.run.triggeredBy = triggeredBy;
    assert.equal((await f.authorize()).reason, 'native_cleanup_diagnostic_not_authorized');
  }
  f.state.run.triggeredBy = 'OWNER';
  for (const startedAt of [new Date(now.getTime() + 1), new Date(now.getTime() - 180_001)]) {
    f.state.run.startedAt = startedAt;
    assert.equal((await f.authorize()).allowed, false);
  }
  f.state.run.startedAt = now;
  f.state.run.status = 'COMPLETED';
  assert.equal((await f.authorize()).allowed, false);
  assert.equal((await f.authorize({ ...input, machineId: 'cmachine00000000000000002' })).allowed, false);
});

test('the native cleanup obligation survives a failed diagnostic changing the primary quarantine reason', async () => {
  const f = fixture();
  f.state.machine.quarantineReasonCode = 'DOCKER_UNAVAILABLE';
  assert.deepEqual(await nativeCleanupContext(f.db, machineId), { required: true, target });
  assert.equal((await f.authorize()).allowed, true);
  f.state.event = null;
  assert.deepEqual(await nativeCleanupContext(f.db, machineId), { required: false, target: null });
});

test('a later Docker stop cannot hide a native cleanup, and multiple native obligations are never guessed', async () => {
  const f = fixture();
  const otherId = 'csession00000000000000002';
  f.db.machineQuarantineEvent.findMany = async () => [
    { details: { sessionId: otherId } }, { details: { sessionId } }, { details: { sessionId } },
  ] as never;
  const other = { ...f.state.selected, id: otherId, runtimeBackend: 'CONTAINER' };
  f.db.workspaceSession.findMany = async () => [other, f.state.selected] as never;
  assert.deepEqual(await nativeCleanupContext(f.db, machineId), { required: true, target });
  other.runtimeBackend = 'WINDOWS_NATIVE';
  assert.deepEqual(await nativeCleanupContext(f.db, machineId), { required: true, target: null });
  assert.equal((await f.authorize()).allowed, false);
});

test('clear machines and ordinary Docker cleanup do not acquire native recovery authority', async () => {
  const f = fixture();
  f.state.machine.moderationStatus = 'CLEAR';
  assert.equal((await f.authorize()).reason, 'native_cleanup_scope_unverified');
  f.state.machine.moderationStatus = 'QUARANTINED';
  f.state.selected.runtimeBackend = 'DOCKER';
  assert.deepEqual(await nativeCleanupContext(f.db, machineId), { required: false, target: null });
  f.state.history = false;
  assert.deepEqual(await nativeCleanupContext(f.db, machineId), { required: false, target: null });
});

test('unknown cleanup origin and resource mapping remain blocked rather than guessed', async () => {
  const variants: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.state.event = null; },
    f => { f.state.event = { details: {} }; },
    f => { f.state.event = { details: { sessionId: 'csession00000000000000002' } }; },
    f => { f.state.selected.booking.acceleratorAllocations = []; },
    f => { f.state.selected.booking.acceleratorAllocations.push(f.state.selected.booking.acceleratorAllocations[0]!); },
    f => { f.state.selected.booking.acceleratorAllocations[0]!.accelerator.vendor = 'AMD'; },
    f => { f.state.selected.booking.acceleratorAllocations[0]!.accelerator.machineId = 'other'; },
    f => { f.state.selected.booking.acceleratorAllocations[0]!.accelerator.hardwareUuid = 'GPU-index-0'; },
    f => { f.state.selected.booking.acceleratorAllocations[0]!.accelerator.miningResource.kind = 'CPU'; },
  ];
  for (const mutate of variants) {
    const f = fixture(); mutate(f);
    assert.deepEqual(await nativeCleanupContext(f.db, machineId), { required: true, target: null });
    assert.equal((await f.authorize()).allowed, false);
    assert.equal(f.redisReads(), 0);
  }
});

test('the requested session, resource and GPU must all match the server quarantine scope', async () => {
  for (const scope of [{ sessionId: 'csession00000000000000002' }, { resourceId: 'cresource0000000000000002' },
    { hardwareUuid: 'GPU-ffffffff-1111-2222-3333-bbbbbbbbbbbb' }]) {
    const f = fixture();
    assert.equal((await f.authorize({ ...input, ...scope })).reason, 'native_cleanup_scope_unverified');
  }
  assert.equal((await fixture().authorize({ ...input, hardwareUuid: input.hardwareUuid.toUpperCase() })).allowed, true);
});

test('running, unended and future-ended native sessions cannot be retired', async () => {
  const f = fixture();
  f.state.terminal.status = WorkspaceSessionStatus.RUNNING;
  assert.equal((await f.authorize()).reason, 'native_cleanup_session_not_terminal');
  f.state.terminal.status = WorkspaceSessionStatus.QUARANTINED;
  for (const endedAt of [null, new Date(now.getTime() + 1)]) {
    f.state.terminal.endedAt = endedAt;
    assert.equal((await f.authorize()).reason, 'native_cleanup_session_not_terminal');
  }
});

test('any live allocation, workspace or mining authority prevents a cleanup authorization', async () => {
  for (const key of ['allocation', 'fullMachine', 'liveSession'] as const) {
    const f = fixture(); f.state[key] = { id: 'live' };
    assert.equal((await f.authorize()).reason, 'native_cleanup_live_work_present');
    assert.equal(f.redisReads(), 0);
  }
  for (const resource of [{ quarantined: true }, { runtimeState: 'MINING' }, { activeRentalId: sessionId }]) {
    const f = fixture(); Object.assign(f.state.resource, resource);
    assert.equal((await f.authorize()).reason, 'native_cleanup_resource_authority_busy');
    assert.equal(f.redisReads(), 0);
  }
});

test('Redis lease presence and missing, malformed or regressed persistent fences refuse recovery without mutation', async () => {
  for (const lease of [1, 2, '1', '0', 'corrupt', null, undefined]) {
    const f = fixture(); f.state.fence = ['90', lease];
    assert.equal((await f.authorize()).reason, 'native_cleanup_resource_lease_busy');
  }
  for (const fence of ['', '0', '089', '89', '900719925474099300000', '9223372036854775808', 90]) {
    const f = fixture(); f.state.fence = [fence, 0];
    assert.equal((await f.authorize()).reason, 'native_cleanup_fence_unverified');
  }
  const f = fixture(); f.redis.eval = async () => { throw new Error('unavailable'); };
  assert.equal((await f.authorize()).reason, 'native_cleanup_authority_unavailable');
});

test('a later persistent floor and int64 fences are preserved exactly without JavaScript number rounding', async () => {
  const f = fixture();
  for (const floor of ['92', '9007199254740993', '9223372036854775807']) {
    f.state.fence = [floor, 0];
    assert.equal((await f.authorize()).fenceFloor, floor);
  }
});

test('strict wire schemas reject numeric/replayed generations and arbitrary proof fields', () => {
  assert.equal(nativeCleanupAuthorityRequestSchema.safeParse(input).success, true);
  for (const runtimeGeneration of [90, true, '0', '090', '1e2', '9223372036854775808']) {
    assert.equal(nativeCleanupAuthorityRequestSchema.safeParse({ ...input, runtimeGeneration }).success, false);
  }
  assert.equal(nativeRuntimeCleanupSchema.safeParse(report).success, true);
  assert.equal(nativeRuntimeCleanupSchema.safeParse({ ...report, clean: true }).success, false);
  assert.equal(nativeRuntimeCleanupSchema.safeParse({ ...report, unsafeRuntimeResourceIds: Array(65).fill(target.resourceId) }).success, false);
});

test('only a complete v2 body-signed proof at the still-current fence can pass the native cleanup gate', async () => {
  const f = fixture();
  const verify = (value: typeof report | undefined, v2 = true) => verifyNativeCleanupReport(f.db, f.redis, runId, machineId, value, v2, now);
  assert.equal(await verify(undefined), 'UNKNOWN');
  assert.equal(await verify(report, false), 'UNKNOWN');
  assert.equal(await verify({ ...report, helperStopped: false }), 'FAIL');
  assert.equal(await verify({ ...report, gpuQuiescent: false }), 'FAIL');
  assert.equal(await verify({ ...report, remainingRentalResourceIds: [target.resourceId] }), 'FAIL');
  assert.equal(await verify({ ...report, unsafeRuntimeResourceIds: [target.resourceId] }), 'FAIL');
  assert.equal(await verify(report), 'PASS');
  f.state.fence = ['91', 0];
  assert.equal(await verify(report), 'UNKNOWN');
  f.state.fence = ['90', 1];
  assert.equal(await verify(report), 'UNKNOWN');
});
