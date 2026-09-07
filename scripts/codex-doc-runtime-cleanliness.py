from pathlib import Path
p = Path('docs/SESSION_RESUME.md')
s = p.read_text()
old = '''- The diagnostic does not verify runtime-level container/network/volume
  cleanup on the agent (only the DB-bookkeeping `allocation` check) — would
  need new agent-side Docker introspection.'''
new = '''- Runtime-level container/network/volume cleanup is now verified by the
  signed, read-only Agent 0.6.3 `runtimeCleanup` diagnostic proof (see
  `docs/RUNTIME_CLEANLINESS_DIAGNOSTIC.md`). The remaining limitation is
  remediation: the diagnostic intentionally does not mutate Docker state;
  automatic remote cleanup still requires the separately-qualified Machine
  Command Gateway rollout.'''
if s.count(old) != 1:
    raise SystemExit(f'known limitation marker count={s.count(old)}')
p.write_text(s.replace(old, new, 1))
