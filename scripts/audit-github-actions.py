#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path

WORKFLOW_DIR = Path(".github/workflows")
PINNED_USE = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
USES = re.compile(r"^\s*uses:\s*([^\s#]+)", re.MULTILINE)
TOP_LEVEL_PERMISSIONS = re.compile(r"^permissions:\s*(?:$|\n)", re.MULTILINE)
TOP_LEVEL_CONCURRENCY = re.compile(r"^concurrency:\s*(?:$|\n)", re.MULTILINE)
TRIGGERED_AUTOMATICALLY = re.compile(r"^\s{2}(?:pull_request|push|schedule):", re.MULTILINE)


def job_blocks(text: str) -> list[tuple[str, str]]:
    lines = text.splitlines()
    try:
        jobs_index = next(i for i, line in enumerate(lines) if line == "jobs:")
    except StopIteration:
        return []
    blocks: list[tuple[str, str]] = []
    i = jobs_index + 1
    while i < len(lines):
        match = re.match(r"^  ([A-Za-z0-9_.-]+):\s*$", lines[i])
        if not match:
            i += 1
            continue
        name = match.group(1)
        start = i
        i += 1
        while i < len(lines) and not re.match(r"^  [A-Za-z0-9_.-]+:\s*$", lines[i]):
            i += 1
        blocks.append((name, "\n".join(lines[start:i])))
    return blocks


def main() -> int:
    errors: list[str] = []
    workflows = sorted(WORKFLOW_DIR.glob("*.yml")) + sorted(WORKFLOW_DIR.glob("*.yaml"))
    if not workflows:
        errors.append("no GitHub Actions workflows found")

    for path in workflows:
        text = path.read_text(encoding="utf-8")
        if "pull_request_target:" in text:
            errors.append(f"{path}: pull_request_target is forbidden by default")

        if not TOP_LEVEL_PERMISSIONS.search(text):
            errors.append(f"{path}: explicit top-level permissions block required")
        if re.search(r"^permissions:\s*write-all\s*$", text, re.MULTILINE):
            errors.append(f"{path}: permissions: write-all is forbidden")

        if TRIGGERED_AUTOMATICALLY.search(text) and not TOP_LEVEL_CONCURRENCY.search(text):
            errors.append(f"{path}: automatic workflows require a top-level concurrency policy")

        for use in USES.findall(text):
            if use.startswith("./") or use.startswith("docker://"):
                continue
            if not PINNED_USE.fullmatch(use):
                errors.append(f"{path}: external Action is not pinned by full commit SHA: {use}")

        for job_name, block in job_blocks(text):
            if "runs-on:" in block and "timeout-minutes:" not in block:
                errors.append(f"{path}: job {job_name} has runs-on but no timeout-minutes")

    if errors:
        print("GitHub Actions security policy violations:", file=sys.stderr)
        for error in errors:
            print(f" - {error}", file=sys.stderr)
        return 1

    print(f"GitHub Actions security policy passed for {len(workflows)} workflow files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
