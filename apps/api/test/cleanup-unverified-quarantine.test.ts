import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Regression for a real, live-reproduced RC1 Phase 5 finding (Test 10): the agent can
// correctly and honestly report that it could not verify GPU container cleanup
// (diagnostic_cleanup_unverified / gpu_proof_cleanup_unverified), yet nothing stopped
// the very next successful heartbeat from silently setting the machine back to
// AVAILABLE — a new renter could then be routed onto a GPU that might still be running
// a leftover container from the previous tenant. Verified live with a real signed
// agent request: job -> FAILED/diagnostic_cleanup_unverified, machine still went
// AVAILABLE on the next heartbeat, before this fix.

async function routeBody(): Promise<string> {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const route = source.indexOf("app.post('/agent/jobs/:id/state'");
  assert.ok(route >= 0, 'the job state-report route must exist');
  const routeEnd = source.indexOf("\napp.", route + 1);
  assert.ok(routeEnd > route);
  return source.slice(route, routeEnd);
}

test('diagnostic_cleanup_unverified and gpu_proof_cleanup_unverified are both classified as cleanup-unverified', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("const CLEANUP_UNVERIFIED_ERROR_CODES=new Set(['diagnostic_cleanup_unverified','gpu_proof_cleanup_unverified']);"));
});

test('a cleanup-unverified terminal report quarantines the machine and blocks it from returning to AVAILABLE', async () => {
  const body = await routeBody();
  assert.ok(body.includes('const cleanupUnverified=terminal&&!!body.errorCode&&CLEANUP_UNVERIFIED_ERROR_CODES.has(body.errorCode)'));
  assert.ok(
    body.includes('if(cleanupUnverified){') &&
      body.includes('moderationStatus:ModerationStatus.QUARANTINED,operational:MachineOperational.UNAVAILABLE'),
    'a cleanup-unverified report must quarantine the machine (which also blocks all further agent auth, see authenticatedAgent) instead of letting the next heartbeat silently mark it AVAILABLE',
  );
});

test('the booking is degraded, never completed, on a cleanup-unverified report', async () => {
  const body = await routeBody();
  assert.ok(body.includes('await tx.booking.updateMany({where:{id:job.bookingId,status:{in:[BookingStatus.FUNDED,BookingStatus.STARTING,BookingStatus.ACTIVE]}},data:{status:BookingStatus.DEGRADED}})'));
  assert.ok(!/cleanupUnverified[\s\S]{0,400}BookingStatus\.COMPLETED/.test(body), 'a cleanup-unverified job must never resolve its booking as COMPLETED');
});

test('the payment is only ever pushed to settlement review, never marked as a paid success', async () => {
  const body = await routeBody();
  assert.ok(body.includes('await tx.payment.updateMany({where:{bookingId:job.bookingId,status:PaymentStatus.ESCROW_FUNDED},data:{status:PaymentStatus.SETTLEMENT_PENDING}})'));
});

test('quarantine is applied idempotently: guarded on moderationStatus already CLEAR', async () => {
  const body = await routeBody();
  assert.ok(
    body.includes('await tx.machine.updateMany({where:{id:body.machineId,moderationStatus:ModerationStatus.CLEAR}'),
    'the machine update must only match machines not already quarantined, so a repeated/duplicate report cannot double-fire the quarantine event',
  );
});

test('an unrelated errorCode never triggers automatic quarantine', async () => {
  const body = await routeBody();
  // The whole block is gated behind `if(cleanupUnverified)`, and cleanupUnverified is only
  // true for the two known codes (asserted above) — any other errorCode (diagnostic_timeout,
  // diagnostic_image_pull_failed, etc.) evaluates cleanupUnverified to false and the block
  // is skipped entirely.
  assert.ok(body.includes('if(cleanupUnverified){'));
  assert.ok(!body.includes("errorCode==='diagnostic_timeout'") || !body.includes('QUARANTINED'), 'sanity: no other errorCode string should be wired to the quarantine block');
});

test('terminal re-reports are fenced: only the same attempt may retry the same terminal status without replaying side effects', async () => {
  const body = await routeBody();
  assert.ok(body.includes('if(terminalJobStatusSet.has(job.status)){'), 'terminal jobs need an explicit early replay gate');
  assert.ok(body.includes('if(!terminalExecutionMatches(job,body))return {kind:\'stale\'} as const'), 'an obsolete attempt must be fenced before any side effect');
  assert.ok(body.includes('if(job.status===next)return {kind:\'ok\',value:{id,status:job.status,duplicate:true}} as const'), 'a lost HTTP response may retry the exact same terminal result idempotently');
  assert.ok(body.includes("if(outcome.kind==='stale')return reply.code(409).send({error:'stale_job_attempt'})"), 'stale workers must receive a stable 409 error');
  const terminalGate = body.indexOf('if(terminalJobStatusSet.has(job.status)){');
  const quarantineBlock = body.indexOf('if(cleanupUnverified){');
  assert.ok(terminalGate >= 0 && quarantineBlock > terminalGate, 'terminal replay handling must run before cleanup/quarantine side effects');
});

test('nothing in server.ts silently clears a quarantine back to CLEAR: lifting it requires a controlled, out-of-band administrative action', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const writesToClear = /data:\{[^}]*moderationStatus:ModerationStatus\.CLEAR[^}]*\}/.test(source);
  assert.equal(writesToClear, false, 'no route may write moderationStatus back to CLEAR automatically — only the two documented QUARANTINED write sites should exist');
  const quarantineWrites = source.match(/data:\{[^}]*moderationStatus:ModerationStatus\.QUARANTINED[^}]*\}/g) ?? [];
  assert.equal(quarantineWrites.length, 2, 'exactly two write sites are expected: the signature-failure quarantine and the cleanup-unverified quarantine added here');
});
