#!/usr/bin/env python3
"""CPU-only source gates. NEVER interpret a passing result as GPU qualification."""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / "workspaces"
spec = json.loads((DIR / "incubator" / "candidates.json").read_text(encoding="utf-8"))
candidates = spec["candidates"]
assert len(candidates) == 6 and spec["neverBookable"] is True
assert len({item["slug"] for item in candidates}) == 6
api_catalog = (ROOT / "apps/api/src/machine-workspace-catalog.ts").read_text(encoding="utf-8")
gateway = (ROOT / "agent/gpubnb_agent/workspace_gateway.py").read_text(encoding="utf-8")
actual_api = re.search(r"executableWorkspaceSlugs = \[([^]]+)\]", api_catalog).group(1)
actual_gateway = re.search(r"GATEWAY_WORKSPACE_SLUGS = frozenset\(\{([^}]+)\}\)", gateway).group(1)
assert len(actual_api.split(",")) == 9
assert len(actual_gateway.split(",")) == 8  # compute has separate batch path
for item in candidates:
    slug = item["slug"]
    folder = DIR / slug
    assert folder.is_dir(), slug
    dockerfile = (folder / "Dockerfile").read_text(encoding="utf-8")
    assert re.search(r"^FROM\s+\S+@sha256:[0-9a-f]{64}\s*$", dockerfile, re.MULTILINE), slug
    assert re.search(r"^USER\s+(coder|jovyan)\s*$", dockerfile, re.MULTILINE), slug
    assert "HEALTHCHECK " in dockerfile, slug
    assert "ENTRYPOINT " in dockerfile or "CMD " in dockerfile, slug
    assert "curl -fsSL https://ollama.com/install.sh | sh" not in dockerfile
    assert slug not in actual_api, slug
    assert slug not in actual_gateway, slug
    assert item["bookable"] is False and item["status"] == "DESIGN_ONLY"
    for source in sorted(folder.glob("*.py")):
        compile(source.read_bytes(), str(source), "exec")
    for script in sorted(folder.glob("*.sh")):
        subprocess.run(["sh", "-n", str(script)], check=True)
print("PASS six software-backed Dockerfiles and design-only booking guards")
print("IMPORTANT: no Docker builds, CUDA jobs, renter sessions or game connections were executed")
