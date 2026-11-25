#!/usr/bin/env python3
"""Read-only pinned Git source-delta evidence for the private Stage 4 backend.

This proves nothing about the deployed container bytes, session authority,
physical GPU state, or a future installation. It never deploys or modifies
repository state. The source comparison must not be treated as a release permit.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

COMMIT = re.compile(r"^[0-9a-f]{40}$")
API_RUNTIME_INPUTS = frozenset(
    {
        "apps/api/Dockerfile",
        "apps/api/package.json",
        "apps/api/package-lock.json",
        "apps/api/tsconfig.json",
    }
)
API_RUNTIME_PREFIXES = ("apps/api/src/", "apps/api/prisma/", "apps/api/scripts/")

# Previously classified Gaming web snapshots (PRs #387 and #398).
# These are source-report expectations, NOT security approvals or release pins.
# Descendants inherit an expectation only for the identical complete web tree.
GAMING_WEB_SOURCE_SNAPSHOTS = (
    ("778ee8b9ede2fb14d807f19ae43319dea1fbb920", "5efddae1ed19e11c173a68d52a77d6ac8bd84ed7"),
    ("241bc7ff5815c709cc3a47ee8463dc99dc825af7", "92c536dbec78df50c42ca687cad1a39096acee4e"),
)


def _git(repo: Path, *args: str, binary: bool = False) -> bytes | str:
    # All arguments are fixed strings or separately validated Git SHAs.
    # Never invoke a shell or fetch untrusted remote refs.
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if binary:
        return result.stdout
    return result.stdout.decode("utf-8", errors="strict").strip()


def source_delta(repo: Path, base: str, candidate: str) -> list[str]:
    if not COMMIT.fullmatch(base) or not COMMIT.fullmatch(candidate) :
        raise ValueError("stage4_delta_exact_distinct_git_commit_pins_required")
    for sha in (base, candidate):
        if _git(repo, "rev-parse", "--verify", sha + "^{commit}") != sha:
            raise ValueError("stage4_delta_pin_not_exact_commit")
    try:
        _git(repo, "merge-base", "--is-ancestor", base, candidate)
    except subprocess.CalledProcessError as exc:
        raise ValueError("stage4_delta_base_not_ancestor") from exc
    # -z handles whitespace, tabs, newlines and Unicode paths correctly.
    names = _git(repo, "diff", "--name-only", "-z", "--no-renames", base, candidate, binary=True)
    if not isinstance(names, bytes):
        raise RuntimeError("stage4_delta_unexpected_git_output")
    return sorted(name.decode("utf-8", errors="strict") for name in names.split(b"\0") if name)


def matches_pinned_web_snapshot(
    repo: Path,
    candidate: str,
    snapshots: tuple[tuple[str, str], ...] = GAMING_WEB_SOURCE_SNAPSHOTS,
) -> bool:
    """Classify known web source only by exact tree identity and ancestry."""
    if not COMMIT.fullmatch(candidate):
        raise ValueError("stage4_delta_pin_not_exact_commit")
    if _git(repo, "rev-parse", "--verify", candidate + "^{commit}") != candidate:
        raise ValueError("stage4_delta_pin_not_exact_commit")
    tree = _git(repo, "rev-parse", "--verify", candidate + ":apps/web")
    for commit, expected_tree in snapshots:
        if not COMMIT.fullmatch(commit) or not COMMIT.fullmatch(expected_tree):
            raise ValueError("stage4_delta_invalid_web_snapshot_pin")
        if tree != expected_tree:
            continue
        if (
            _git(repo, "rev-parse", "--verify", commit + "^{commit}") != commit
            or _git(repo, "rev-parse", "--verify", commit + ":apps/web") != expected_tree
        ):
            raise ValueError("stage4_delta_web_snapshot_pin_mismatch")
        try:
            _git(repo, "merge-base", "--is-ancestor", commit, candidate)
        except subprocess.CalledProcessError:
            continue
        return True
    return False


def analyze_source_delta(changed: list[str]) -> dict[str, object]:
    api_changes = sorted(
        path for path in changed if
        path in API_RUNTIME_INPUTS or path.startswith(API_RUNTIME_PREFIXES)
    )
    web_changes = sorted(path for path in changed if path.startswith("apps/web/"))
    agent_changes = sorted(path for path in changed if path.startswith("agent/"))
    native_changes = sorted(path for path in changed if path.startswith("native/"))
    return {
        "changedPaths": sorted(changed),
        "changedPathCount": len(changed),
        "apiRuntimeInputChanges": api_changes,
        "webAssetChanges": web_changes,
        "agentChanges": agent_changes,
        "nativeChanges": native_changes,
        "apiRuntimeInputsIdenticalAtSource": len(api_changes) == 0,
        "webAssetsIdenticalAtSource": len(web_changes) == 0,
        "agentCodeIdenticalAtSource": len(agent_changes) == 0,
        "nativeCodeIdenticalAtSource": len(native_changes) == 0,
    }


def make_report(repo: Path, base: str, candidate: str) -> dict[str, object]:
    changed = source_delta(repo, base, candidate)
    analysis = analyze_source_delta(changed)
    docker = _git(repo, "show", candidate + ":apps/api/Dockerfile")
    if not isinstance(docker, str) or not re.search(
        r"(?m)^\s*COPY\s+apps/web\s+/app/web\s*$", docker
    ):
        raise ValueError("stage4_delta_expected_api_container_web_copy_missing")
    return {
        "kind": "STAGE4_PRIVATE_RENDER_SOURCE_DELTA_READONLY",
        "privateRenderObservedCommit": base,
        "reviewedSourceCommit": candidate,
        # This is only a source snapshot. Nothing here proves a signed or live artifact.
        "reviewedSourceBuiltSignedOrInstalled": False,
        "apiDockerBuildIncludesWebAssets": True,
        **analysis,
        # A source-code diff is not an attestation of the live Docker image.
        "renderRunningImageCommitIndependentlyAttested": False,
        "browserSessionProtocolCompatibilityAttested": False,
        "signedOwnerCleanupEvidenceReceived": False,
        "pc1ServiceTransactionalRollbackTested": False,
        "installationAuthorized": False,
        "quarantineModified": False,
        "publicBookabilityEnabled": False,
        "nextGate": "private_release_review_and_verified_runtime_then_physical_maintenance",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="Local repository path, read only")
    parser.add_argument("--private-render-commit", required=True)
    parser.add_argument("--pc1-candidate-commit", required=True)
    parser.add_argument("--expect-api-source-unchanged", action="store_true")
    parser.add_argument("--expect-api-source-changed", action="store_true")
    parser.add_argument("--expect-web-source-changed", action="store_true")
    parser.add_argument("--expect-web-source-unchanged", action="store_true")
    parser.add_argument("--expect-known-gaming-web-snapshot", action="store_true",
                        help="Expect changed web source only for exact pinned Gaming snapshots")
    args = parser.parse_args()
    if args.expect_known_gaming_web_snapshot and (
        args.expect_web_source_changed or args.expect_web_source_unchanged
    ):
        raise SystemExit("stage4_delta_conflicting_web_expectations")
    report = make_report(
        Path(args.repo).resolve(),
        args.private_render_commit,
        args.pc1_candidate_commit,
    )
    if args.expect_known_gaming_web_snapshot:
        known = matches_pinned_web_snapshot(Path(args.repo).resolve(), args.pc1_candidate_commit)
        args.expect_web_source_changed = known
        args.expect_web_source_unchanged = not known
        report["knownGamingWebSnapshotMatched"] = known
    if args.expect_api_source_changed and args.expect_api_source_unchanged:
        raise SystemExit("stage4_delta_conflicting_api_expectations")
    if args.expect_web_source_changed and args.expect_web_source_unchanged:
        raise SystemExit("stage4_delta_conflicting_web_expectations")
    if args.expect_api_source_unchanged and not report["apiRuntimeInputsIdenticalAtSource"]:
        raise SystemExit("stage4_delta_api_runtime_inputs_changed_review_required")
    if args.expect_api_source_changed and report["apiRuntimeInputsIdenticalAtSource"]:
        raise SystemExit("stage4_delta_expected_api_runtime_change_missing")
    if args.expect_web_source_changed and report["webAssetsIdenticalAtSource"]:
        raise SystemExit("stage4_delta_web_difference_expectation_failed")
    if args.expect_web_source_unchanged and not report["webAssetsIdenticalAtSource"]:
        raise SystemExit("stage4_delta_web_source_changed_review_required")
    print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
