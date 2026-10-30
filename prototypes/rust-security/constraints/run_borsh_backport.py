#!/usr/bin/env python3
"""Bounded published-backport test; all report findings remain blocking."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tomllib


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fresh_directory", type=Path)
    work = parser.parse_args().fresh_directory.resolve()
    work.mkdir(mode=0o700, exist_ok=False)
    (work / "src").mkdir()
    here = Path(__file__).resolve().parent
    shutil.copyfile(here / "borsh_backport.rs", work / "src/main.rs")
    (work / "Cargo.toml").write_text('[package]\nname="gpubnb-borsh-backport-review"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nborsh="=0.10.4"\n[workspace]\n')
    with (work / "run.log").open("wb") as out, (work / "build.log").open("wb") as err:
        subprocess.run(["cargo", "run", "--release"], cwd=work, stdout=out, stderr=err, check=True, timeout=600)
    lock = tomllib.loads((work / "Cargo.lock").read_text())
    crate = [p for p in lock["package"] if p["name"] == "borsh"]
    checksum = "115e54d64eb62cdebad391c19efc9dce4981c690c85a33a12199d99bb9546fee"
    assert len(crate) == 1 and crate[0]["version"] == "0.10.4" and crate[0]["checksum"] == checksum
    assert (work / "run.log").read_text().strip() == "BORSH_0_10_4_BACKPORT_PASS zst_rejections=3 ordinary_vector=PASS scanner_gate=UNCHANGED"
    report = {"status": "PASS — VERIFIED", "scope": "published0.10.4 ZST-vector rejection only",
              "crateSha256": checksum, "outputSha256": hashlib.sha256((work / "run.log").read_bytes()).hexdigest(),
              "scannerDisposition": "BLOCKED; no ignore/exception/filter/version spoof",
              "financialMigration": "NOT QUALIFIED", "oldVulnerableVersionExecuted": False}
    (work / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
