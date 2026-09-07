from pathlib import Path
p = Path('agent/tests/test_self_update.py')
s = p.read_text()
old = '''def _fake_run_version_command(_candidate_path: Path) -> str:
    # The default real implementation actually executes the candidate exe -
    # these fixtures are not real executables, so every perform_self_update
    # call that reaches the version-check stage must inject this instead.
    return "0.6.2"
'''
new = '''def _fake_run_version_command(_candidate_path: Path) -> str:
    # The default real implementation actually executes the candidate exe -
    # these fixtures are not real executables, so every perform_self_update
    # call that reaches the version-check stage must inject a version strictly
    # newer than the current Agent release instead.
    return "0.6.4"
'''
if s.count(old) != 1:
    raise SystemExit(f'fake update version marker count={s.count(old)}')
p.write_text(s.replace(old, new, 1))
