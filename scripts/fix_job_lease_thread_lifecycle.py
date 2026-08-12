from pathlib import Path

path = Path('agent/gpubnb_agent/cli.py')
source = path.read_text(encoding='utf-8')
old = '''    lease_thread.start()\n    parameters = job.get("parameters") if isinstance(job.get("parameters"), dict) else {}\n    workspace_slug = str(parameters.get("workspaceSlug") or "compute")\n    image = workspace_image(config, workspace_slug)\n    try:\n'''
new = '''    parameters = job.get("parameters") if isinstance(job.get("parameters"), dict) else {}\n    workspace_slug = str(parameters.get("workspaceSlug") or "compute")\n    image = workspace_image(config, workspace_slug)\n    lease_thread.start()\n    try:\n'''
if source.count(old) != 1:
    raise RuntimeError(f'lease lifecycle marker count={source.count(old)}')
path.write_text(source.replace(old, new, 1), encoding='utf-8', newline='\n')
Path('.github/workflows/fix-job-lease-thread-lifecycle.yml').unlink(missing_ok=True)
Path('scripts/fix_job_lease_thread_lifecycle.py').unlink(missing_ok=True)
