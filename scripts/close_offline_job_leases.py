from pathlib import Path

p=Path('apps/api/src/offline-sweep-service.ts')
s=p.read_text(encoding='utf-8')
old="""          data: {
            status: JobStatus.CANCELLED,
            errorCode: 'AGENT_OFFLINE',
            cancelRequestedAt: now,
            finishedAt: now,
          },
        })
      : { count: 0 };

    const paymentUpdate"""
new="""          data: {
            status: JobStatus.CANCELLED,
            errorCode: 'AGENT_OFFLINE',
            cancelRequestedAt: now,
            finishedAt: now,
            leaseExpiresAt: null,
          },
        })
      : { count: 0 };

    if (jobUpdate.count > 0) {
      await tx.jobAttempt.updateMany({
        where: {
          jobId: { in: plan.cancelledJobIds },
          finishedAt: null,
          job: { status: JobStatus.CANCELLED, errorCode: 'AGENT_OFFLINE' },
        },
        data: { finishedAt: now, failureReason: 'AGENT_OFFLINE' },
      });
    }

    const paymentUpdate"""
if s.count(old)!=1:
    raise RuntimeError(f'offline job marker count={s.count(old)}')
p.write_text(s.replace(old,new,1),encoding='utf-8',newline='\n')
Path('.github/workflows/close-offline-job-leases.yml').unlink(missing_ok=True)
Path('scripts/close_offline_job_leases.py').unlink(missing_ok=True)
