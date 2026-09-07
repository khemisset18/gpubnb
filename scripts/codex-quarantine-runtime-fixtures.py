from pathlib import Path

p = Path('apps/api/test/quarantine-diagnostics-system.test.ts')
s = p.read_text()

old_full = "['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'allocation', 'cuda', 'ram']"
new_full = "['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'runtimeCleanup', 'allocation', 'cuda', 'ram']"
count_full = s.count(old_full)
if count_full != 3:
    raise SystemExit(f'full passing mandatory fixture count={count_full}, expected 3')
s = s.replace(old_full, new_full)

old_core = "['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'allocation']"
new_core = "['agent', 'gpu', 'gpuUuid', 'driver', 'docker', 'nvidiaRuntime', 'runtimeCleanup', 'allocation']"
count_core = s.count(old_core)
if count_core != 1:
    raise SystemExit(f'core mandatory fixture count={count_core}, expected 1')
s = s.replace(old_core, new_core)

p.write_text(s)
