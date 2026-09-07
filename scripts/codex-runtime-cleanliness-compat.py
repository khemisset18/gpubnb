from pathlib import Path

p = Path('agent/gpubnb_agent/cli.py')
s = p.read_text()
old = '''    expected_runtime_session_ids = pending.get("expectedRuntimeSessionIds")
    if not isinstance(expected_runtime_session_ids, list):
        expected_runtime_session_ids = []
    try:
'''
new = '''    expected_runtime_session_ids = pending.get("expectedRuntimeSessionIds")
    runtime_expectation_supplied = isinstance(expected_runtime_session_ids, list)
    if not runtime_expectation_supplied:
        expected_runtime_session_ids = []
    try:
'''
if s.count(old) != 1:
    raise SystemExit(f'expectation marker count={s.count(old)}')
s = s.replace(old, new, 1)
old = '''        runtime_cleanliness = inspect_runtime_cleanliness([
            value for value in expected_runtime_session_ids
            if isinstance(value, str) and value
        ])
        report = run_gpu_diagnostic(image, timeout_seconds)
'''
new = '''        runtime_cleanliness = (
            inspect_runtime_cleanliness([
                value for value in expected_runtime_session_ids
                if isinstance(value, str) and value
            ])
            if runtime_expectation_supplied
            else None
        )
        report = run_gpu_diagnostic(image, timeout_seconds)
'''
if s.count(old) != 1:
    raise SystemExit(f'inspection marker count={s.count(old)}')
s = s.replace(old, new, 1)
old = '''            "metrics": metrics,
            "runtimeCleanliness": runtime_cleanliness.to_api_payload(),
        })
'''
new = '''            "metrics": metrics,
            **({"runtimeCleanliness": runtime_cleanliness.to_api_payload()} if runtime_cleanliness is not None else {}),
        })
'''
if s.count(old) != 1:
    raise SystemExit(f'payload marker count={s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s)
