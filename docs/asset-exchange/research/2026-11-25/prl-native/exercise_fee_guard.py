"""Run the public qualification CLI and retain stdout and stderr for each private policy."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def run(args, rate, commitments):
    command = [sys.executable, "-u", str(args.qualify), "--pearld", str(args.pearld),
               "--verify-refund", str(args.verifier), "--network", args.network, "--material", str(args.material),
               "--commitment", commitments["recovery-intent-commitment"],
               "--recipient-commitment", commitments["recipient-spend-commitment"],
               "--observer-b-relay", str(rate), "--fee-bump", "--fee-boundaries", "--high-relay"]
    base = args.output / f"{args.network}-fee-{rate}"
    with base.with_suffix(".jsonl").open("x") as out, base.with_suffix(".stderr").open("x") as err:
        result = subprocess.run(command, stdout=out, stderr=err, timeout=1800)
    rows = [json.loads(line) for line in base.with_suffix(".jsonl").read_text().splitlines()]
    checks = [row for row in rows if row["case"] == "refund-fee-check-before-funding"]
    expected = [("a", 1000, 138, True), ("b", rate, rate * 138 // 1000, rate == 1000)]
    actual = [(r["observer"], r["min_relay_grains_per_kvb"], r["required_grains"], r["covered"]) for r in checks]
    assert actual == expected and all(not r["funding_submitted"] and r["budget_grains"] == 1500
                                      and r["vsize"] == 138 for r in checks), checks
    cases = [r["case"] for r in rows]
    if rate == 1000:
        assert result.returncode == 0 and cases[-1] == "qualification-run-complete" and not base.with_suffix(".stderr").stat().st_size
        assert cases.index("funding-confirmed") < cases.index("independent-recipient-spent-refund")
        print(f"{args.network} A=1000 B=1000 both covered; funding, refund and recipient confirmed; exit=0", flush=True)
    else:
        assert result.returncode == 1 and "funding-confirmed" not in cases and "qualification-run-complete" not in cases
        assert [r["exit"] for r in rows if r["case"] == "node-stopped"] == [0, 0]
        assert base.with_suffix(".stderr").read_text().splitlines()[-1] == (
            "RuntimeError: funding refused: verified refund fee below observer relay floor")
        print(f"{args.network} A=1000 B={rate} funding refused before broadcast; both nodes stopped; exit=1 expected", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", required=True, choices=("regtest", "simnet"))
    for option in ("qualify", "pearld", "verifier", "material", "preparation", "output"):
        parser.add_argument("--" + option, type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    receipt = [json.loads(line) for line in args.preparation.read_text().splitlines()]
    commitments = {r["case"]: r["sha256"] for r in receipt if "sha256" in r and r["network"] == args.network}
    for rate in (11_000, 20_000, 1_000):
        run(args, rate, commitments)
