"""Build metadata for this specific agent artifact, not the source tree.

BUILD_COMMIT is overwritten by CI with the real 12-char commit SHA
immediately before PyInstaller freezes the agent (see
.github/workflows/publish-host-test-release.yml), so a running exe can
report exactly which commit it was actually built from - this is the field
that would have made the stale-frozen-binary incident (see
docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md #14) immediately detectable instead of
requiring a manual file-timestamp/process-command-line investigation.

An editable/pip install (`pip install -e ./agent`), which is never frozen,
keeps the "dev" default below - it always reflects live source by
definition, so there is nothing meaningful to compare it against.
"""
from __future__ import annotations

BUILD_COMMIT = "dev"
