from pathlib import Path

path = Path('apps/api/src/server.ts')
source = path.read_text(encoding='utf-8')
old = "type JobLeaseBody={attemptId?:string;leaseToken?:string};"
new = "type JobLeaseBody={attemptId?:string|undefined;leaseToken?:string|undefined};"
if source.count(old) != 1:
    raise RuntimeError(f'expected one JobLeaseBody marker, found {source.count(old)}')
path.write_text(source.replace(old, new, 1), encoding='utf-8', newline='\n')
Path('.github/workflows/fix-strict-job-lease-types.yml').unlink(missing_ok=True)
Path('scripts/fix_strict_job_lease_types.py').unlink(missing_ok=True)
