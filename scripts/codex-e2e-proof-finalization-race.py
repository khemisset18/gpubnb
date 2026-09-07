from pathlib import Path

p = Path('e2e/run.cjs')
s = p.read_text()
old = '''  log('7c. waiting for the real agent to execute and finalize the real GPU_PROOF job');
  const proofJob = await waitUntil('GPU_PROOF completes', async () => {
    const job = await prisma.job.findFirst({
      where: { bookingId: booking.id, type: 'GPU_PROOF' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, result: true, errorCode: true },
    });
    if (!job) return null;
    if (['FAILED', 'CANCELLED', 'TIMED_OUT', 'REJECTED', 'QUARANTINED'].includes(job.status)) {
      throw new Error(`GPU_PROOF failed: ${job.status}:${job.errorCode || 'unknown'}`);
    }
    return job.status === 'COMPLETED' ? job : null;
  }, { timeoutMs: 600_000, intervalMs: 2000 });
  const proofResult = proofJob.result && typeof proofJob.result === 'object' ? proofJob.result : {};
  if (proofResult.gpuDetected !== true) {
    throw new Error('GPU_PROOF completed without gpuDetected=true: ' + JSON.stringify(proofResult));
  }
  const afterProof = await prisma.booking.findUniqueOrThrow({
    where: { id: booking.id },
    select: { status: true, workspaceActivatedAt: true },
  });
  if (afterProof.status !== 'STARTING' || afterProof.workspaceActivatedAt !== null) {
    throw new Error('GPU_PROOF must keep the booking reserved for Developer activation: ' + JSON.stringify(afterProof));
  }
  log('    GPU_PROOF completed', { jobId: proofJob.id, bookingStatus: afterProof.status });
'''
new = '''  log('7c. waiting for the real agent to execute and finalize the real GPU_PROOF job');
  const finalizedProof = await waitUntil('GPU_PROOF completes and finalizes', async () => {
    const job = await prisma.job.findFirst({
      where: { bookingId: booking.id, type: 'GPU_PROOF' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, result: true, errorCode: true },
    });
    if (!job) return null;
    if (['FAILED', 'CANCELLED', 'TIMED_OUT', 'REJECTED', 'QUARANTINED'].includes(job.status)) {
      throw new Error(`GPU_PROOF failed: ${job.status}:${job.errorCode || 'unknown'}`);
    }
    if (job.status !== 'COMPLETED') return null;
    const proofResult = job.result && typeof job.result === 'object' ? job.result : {};
    if (proofResult.gpuDetected !== true || proofResult.metrics?.containerCleaned !== true) {
      throw new Error('GPU_PROOF completed without verified GPU use and cleanup: ' + JSON.stringify(proofResult));
    }
    const bookingAfterProof = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { status: true, workspaceActivatedAt: true },
    });
    // /agent/jobs/:id/complete stores the verified result before the agent calls
    // /finalize-proof. FUNDED here is a legitimate tiny race; wait for the server-side
    // finalization rather than treating that inter-request gap as a product failure.
    if (bookingAfterProof.status === 'FUNDED' && bookingAfterProof.workspaceActivatedAt === null) return null;
    if (bookingAfterProof.status !== 'STARTING' || bookingAfterProof.workspaceActivatedAt !== null) {
      throw new Error('GPU_PROOF must keep the booking reserved for Developer activation: ' + JSON.stringify(bookingAfterProof));
    }
    return { job, booking: bookingAfterProof };
  }, { timeoutMs: 600_000, intervalMs: 2000 });
  log('    GPU_PROOF completed and finalized', { jobId: finalizedProof.job.id, bookingStatus: finalizedProof.booking.status });
'''
if s.count(old) != 1:
    raise SystemExit(f'proof finalization block marker count={s.count(old)}')
p.write_text(s.replace(old, new, 1))

# Keep the source-level ratchet aligned with the strengthened contract.
t = Path('apps/api/test/e2e-real-gpu-proof-contract.test.ts')
test_source = t.read_text()
test_source = test_source.replace("waitUntil('GPU_PROOF completes'", "waitUntil('GPU_PROOF completes and finalizes'")
test_source = test_source.replace("assert.match(e2e, /proofResult\\.gpuDetected !== true/);", "assert.match(e2e, /proofResult\\.gpuDetected !== true \\|\\| proofResult\\.metrics\\?\\.containerCleaned !== true/);")
test_source = test_source.replace("assert.match(e2e, /afterProof\\.status !== 'STARTING'/);\n  assert.match(e2e, /afterProof\\.workspaceActivatedAt !== null/);", "assert.match(e2e, /bookingAfterProof\\.status === 'FUNDED'/);\n  assert.match(e2e, /bookingAfterProof\\.status !== 'STARTING'/);\n  assert.match(e2e, /bookingAfterProof\\.workspaceActivatedAt !== null/);")
t.write_text(test_source)
