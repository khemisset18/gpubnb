#!/usr/bin/env python3
"""Execute only generated host account validation and metadata, against both pins.

No contract handler/CPI, SBF tools, signer, node, transaction or network RPC.
Cargo may download checksum-verified packages. Financial source is copied intact.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tomllib

BASE = "710ff0a98f02178e62942f98056d59879995efbf"
CANDIDATE = "cbf8607549b036d04781026c7b7e3be1da26cff4"
SOURCE_SHA = "ffaa27c11cc7873282a85b05f2cfc0bcd8a6b8baba3154575596225b5faa8b41"


def expected():
    cases = {
        "admin_valid": "OK", "admin_missing_signer": "AccountNotSigner:3010",
        "admin_wrong_authority": "ConstraintHasOne:2001", "admin_readonly": "ConstraintMut:2000",
        "admin_wrong_owner": "AccountOwnedByWrongProgram:3007", "admin_wrong_seed": "ConstraintSeeds:2006",
        "admin_bad_discriminator": "AccountDiscriminatorMismatch:3002", "admin_bad_boolean": "AccountDidNotDeserialize:3003",
        "dispute_valid": "OK", "dispute_missing_signer": "AccountNotSigner:3010",
        "dispute_wrong_buyer": "ConstraintHasOne:2001", "oracle_valid": "OK",
        "oracle_wrong_authority": "ConstraintHasOne:2001", "oracle_missing_signer": "AccountNotSigner:3010",
        "finalize_valid": "OK", "finalize_wrong_owner": "AccountOwnedByWrongProgram:3007",
        "finalize_readonly": "ConstraintMut:2000", "finalize_wrong_buyer": "ConstraintHasOne:2001",
        "finalize_wrong_provider": "ConstraintHasOne:2001", "finalize_wrong_platform": "ConstraintHasOne:2001",
        "finalize_alias_provider_platform": "OK",
    }
    # Independent manual account-order/signer/writable specification from the
    # financial source. No Anchor-generated IDL is used as its own oracle.
    admin = [(1,1,0),(2,0,1)]
    metas = {
        "initialize_config": [(1,1,1),(2,0,1),(9,0,0)],
        "update_config": admin, "set_paused": admin, "propose_admin": admin,
        "accept_admin": admin,
        "open": [(2,0,0),(6,1,1),(7,0,0),(8,0,1),(9,0,0)],
        "propose_settlement": [(2,0,0),(4,1,0),(8,0,1)],
        "dispute": [(6,1,0),(8,0,1)],
        "finalize": [(2,0,0),(8,0,1),(6,0,1),(7,0,1),(3,0,1)],
        "resolve_dispute": [(2,0,0),(1,1,0),(8,0,1),(6,0,1),(7,0,1),(3,0,1)],
        "refund_expired": [(8,0,1),(6,0,1)],
    }
    out = {"constraint:" + k: v for k, v in cases.items()}
    for name, entries in metas.items():
        for i, (key, signer, writable) in enumerate(entries):
            out[f"meta:{name}:{i}"] = bytes([key] * 32).hex() + f":{signer}{writable}"
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fresh_directory", type=Path)
    args = parser.parse_args()
    work = args.fresh_directory.resolve()
    work.mkdir(mode=0o700, exist_ok=False)
    here = Path(__file__).resolve().parent
    repo = here.parents[2]
    results = []
    for name, commit, version in [("baseline", BASE, "0.31.1"), ("candidate", CANDIDATE, "1.2.2")]:
        def original(path):
            return subprocess.check_output(["git", "show", f"{commit}:{path}"], cwd=repo)
        source = original("programs/gpu_escrow/src/lib.rs")
        if hashlib.sha256(source).hexdigest() != SOURCE_SHA:
            raise RuntimeError("financial source hash mismatch")
        root = work / name
        crate = root / "programs/gpu_escrow"
        (crate / "src").mkdir(parents=True)
        (crate / "examples").mkdir()
        (crate / "src/lib.rs").write_bytes(source)
        (crate / "examples/host_constraints.rs").write_bytes((here / "host_constraints.rs").read_bytes())
        manifest = original("programs/gpu_escrow/Cargo.toml")
        required = tomllib.loads(manifest.decode())["dependencies"]["anchor-lang"]
        if required != (version if name == "baseline" else "=" + version):
            raise RuntimeError("unexpected Anchor manifest")
        (crate / "Cargo.toml").write_bytes(manifest.replace(b"[dependencies]", b"probe-anchor-v1=[]\n[dependencies]"))
        (root / "Cargo.toml").write_text('[workspace]\nmembers=["programs/gpu_escrow"]\nresolver="2"\n')
        frozen_lock = original("Cargo.lock")
        (root / "Cargo.lock").write_bytes(frozen_lock)
        output, log = work / f"{name}.tsv", work / f"{name}.log"
        # Cargo prunes unrelated workspace packages in this disposable copy;
        # no dependency version change is accepted by the checks below.
        with output.open("wb") as out, log.open("wb") as err:
            command = ["cargo", "run", "--example", "host_constraints"]
            if name == "candidate":
                command.extend(["--features", "probe-anchor-v1"])
            result = subprocess.run(command, cwd=root,
                                    env=os.environ.copy(), stdout=out, stderr=err, timeout=900)
        if result.returncode:
            raise RuntimeError(f"{name} host probe failed; see {log}")
        packages = tomllib.loads((root / "Cargo.lock").read_text())["package"]
        def identity(package):
            return tuple(package.get(field) for field in ("name", "version", "source", "checksum"))
        frozen = {identity(p) for p in tomllib.loads(frozen_lock.decode())["package"]}
        if not {identity(p) for p in packages}.issubset(frozen):
            raise RuntimeError("dependency identity changed outside the frozen source lock")
        if [p["version"] for p in packages if p["name"] == "anchor-lang"] != [version]:
            raise RuntimeError("Anchor version changed in disposable resolution")
        rows = [line.split("\t") for line in output.read_text().splitlines()]
        actual = dict(rows)
        if len(actual) != len(rows) or actual != expected():
            differences = {k: {"expected": expected().get(k), "actual": actual.get(k)}
                           for k in sorted(expected().keys() | actual.keys()) if expected().get(k) != actual.get(k)}
            raise RuntimeError("independent constraint/metadata mismatch: " + json.dumps(differences))
        results.append({"label": name, "commit": commit, "anchor": version,
                        "sourceSha256": SOURCE_SHA, "outputSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                        "checks": len(actual), "status": "PASS — VERIFIED"})
    report = {"scope": "generated host account validation and client instruction metadata only",
              "accountValidationCasesPerVersion": 21, "instructionsWithIndependentMetas": 11,
              "results": results, "financialIntegration": "BLOCKED",
              "notTested": ["SBF", "dispatcher execution", "financial handlers", "CPI execution",
                            "runtime privilege escalation/rollback", "account close", "on-chain client submission"]}
    (work / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
