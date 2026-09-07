from pathlib import Path

p = Path('e2e/run.cjs')
s = p.read_text()

old = '''  // The security module flags the very first inventory report as VERIFY/INVENTORY_CHANGED
  // by design (anti-spoofing) - wait one more real heartbeat cycle for it to clear. That same
  // executor also sets operational=VERIFYING (accelerator-security-executor.ts), which in
  // production only clears back to AVAILABLE once a real GPU_PROOF job completes
  // (gpu-proof-completion.ts). This harness doesn't run that separate Compute diagnostic job
  // (it's out of scope - this harness proves the Developer WORKSPACE_PREPARE path), so it must
  // set operational back to AVAILABLE itself here, the same way gpu-proof-completion.ts does,
  // or the machine stays stuck in VERIFYING and every listing/booking call below fails with
  // machine_not_publishable.
'''
new = '''  // The first inventory is intentionally marked VERIFYING by the anti-spoofing path.
  // This local harness still needs a narrow onboarding bootstrap before it can create the
  // listing used by the rental test. IMPORTANT: this bootstrap is not accepted as rental
  // qualification. The booking created below must run a real Compute/GPU_PROOF through the
  // authenticated production route and real Agent before Developer preparation is allowed.
'''
if s.count(old) != 1:
    raise SystemExit(f'onboarding comment marker count={s.count(old)}')
s = s.replace(old, new, 1)

old = '''  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.FUNDED, depositSignature: `dev-bypass:e2e-${Date.now()}` } });

  log('8. real POST /bookings/:id/workspace/developer (the actual "Créer mon espace" button)');
'''
new = '''  await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.FUNDED, depositSignature: `dev-bypass:e2e-${Date.now()}` } });

  log('7b. real Compute preparation request (production route creates GPU_PROOF)');
  const computeRes = await fetch(`${API}/bookings/${booking.id}/workspace-sessions`, {
    method: 'POST',
    headers: { cookie: renter.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceSlug: 'compute' }),
  });
  const computeSession = await computeRes.json();
  if (!computeRes.ok) throw new Error('compute workspace request failed: ' + JSON.stringify(computeSession));
  log('    compute sessionId', computeSession.id);

  log('7c. waiting for the real agent to execute and finalize the real GPU_PROOF job');
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

  log('8. real POST /bookings/:id/workspace/developer after GPU_PROOF (the actual "Créer mon espace" button)');
'''
if s.count(old) != 1:
    raise SystemExit(f'funding/developer marker count={s.count(old)}')
s = s.replace(old, new, 1)

old = "  log('DONE — full real lifecycle proven: booking -> GPU assignment -> real agent -> real Docker -> real GPU -> real code-server -> real gateway register -> real READY -> real access -> real activation -> real stop -> real cleanup -> GPU available for a second rental.');\n"
new = "  log('DONE — full real lifecycle proven: booking -> GPU assignment -> real GPU_PROOF -> real agent -> real Docker -> real GPU -> real code-server -> real gateway register -> real READY -> real access -> real activation -> real stop -> real cleanup -> GPU available for a second rental.');\n"
if s.count(old) != 1:
    raise SystemExit(f'DONE marker count={s.count(old)}')
s = s.replace(old, new, 1)

p.write_text(s)
