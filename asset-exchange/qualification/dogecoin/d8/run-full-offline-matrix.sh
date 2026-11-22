#!/usr/bin/env bash
# Run only in an explicitly isolated root-owned GitHub Actions Linux namespace.
set -euo pipefail
OUT="$1"; SHA="$2"
test "$(id -u)" -eq 0
test "$(git rev-parse HEAD)" = "$SHA"
test "$(readlink /proc/self/ns/net)" != "$(cat "$OUT/parent-netns.txt")"
test "$(ip -o link show | wc -l)" -eq 1
ip -o link show | grep -qE '^[0-9]+: lo:'
ip -o link show > "$OUT/network-links.txt"
ip -o addr show > "$OUT/network-addresses.txt"
mkdir -p "$OUT/logs" "$OUT/results"
failed=0
run_case() {
  local label="$1"; shift
  local code=0
  echo "DOGE_MATRIX_START $label"
  if "$@" >"$OUT/logs/$label.log" 2>&1; then :; else code="$?"; fi
  echo "$code" > "$OUT/results/$label.exit"
  echo "DOGE_MATRIX_END $label exit=$code"
  grep -E '(^# (tests|pass|fail) [0-9]+|^Ran [0-9]+ tests|^OK$|^FAILED |^Syntax PASS:)' "$OUT/logs/$label.log" | tail -n 8 || true
  if test "$code" -ne 0; then failed=1; fi
}
run_case js_syntax npm --prefix asset-exchange run check
run_case js_foundation npm --prefix asset-exchange test
run_case python_d0 python3 -m unittest discover -s asset-exchange/qualification/dogecoin/d0 -p 'test_*.py' -v
run_case python_d1 python3 -m unittest discover -s asset-exchange/qualification/dogecoin/d1 -p 'test_*.py' -v
run_case python_d2 python3 -m unittest discover -s asset-exchange/qualification/dogecoin/d2 -p 'test_*.py' -v
run_case python_d6 python3 -m unittest discover -s asset-exchange/qualification/dogecoin/d6 -p 'test_*.py' -v
run_case python_policy python3 -m unittest discover -s asset-exchange/qualification/dogecoin/policy -p 'test_*.py' -v
run_case python_d8 python3 -m unittest discover -s asset-exchange/qualification/dogecoin/d8 -p 'test_*.py' -v
run_case python_signer python3 -m unittest discover -s asset-exchange/wallet-agent/dogecoin -p 'test_*.py' -v
run_case python_recovery python3 -m unittest discover -s asset-exchange/recovery/dogecoin -p 'test_*.py' -v
run_case bash_boundaries bash -c 'set -euo pipefail; for f in asset-exchange/qualification/dogecoin/d1/run-isolated.sh asset-exchange/qualification/dogecoin/d2/run-isolated.sh asset-exchange/qualification/dogecoin/d2/run-native-spends.sh asset-exchange/qualification/dogecoin/d6/run-multinode.sh asset-exchange/qualification/dogecoin/d8/run-consensus.sh; do bash -n "$f"; done'
python3 - "$OUT" "$SHA" <<'PY'
import hashlib, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
results = []
for record in sorted((root / 'results').glob('*.exit')):
    name = record.stem
    log = (root / 'logs' / (name + '.log')).read_bytes()
    text = log.decode(errors='replace')
    code = int(record.read_text().strip())
    node = re.findall(r'^# tests ([0-9]+)$', text, re.M)
    python = re.findall(r'^Ran ([0-9]+) tests', text, re.M)
    count = int(node[-1]) if node else int(python[-1]) if python else None
    if (name.startswith('python_') or name == 'js_foundation') and not count:
        code = 98
    results.append({'suite': name, 'status': 'PASS' if code == 0 else 'FAIL',
                    'exitCode': code, 'testCount': count,
                    'logSha256': hashlib.sha256(log).hexdigest()})
report = {'sourceSha': sys.argv[2], 'scope': 'ISOLATED_OFFLINE_SOFTWARE_REGRESSION',
          'realDogeUsed': 0, 'mainnetUsed': False, 'chainBroadcast': False,
          'physicalD8Qualified': False, 'trustWalletHTLCQualified': False,
          'D8': 'BLOCKED', 'D9': 'NOT_PERFORMED',
          'suites': results,
          'summary': {'total': len(results),
                      'passed': sum(x['status']=='PASS' for x in results),
                      'failed': sum(x['status']!='PASS' for x in results),
                      'countedTests': sum(x['testCount'] or 0 for x in results)}}
(root / 'software-matrix-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report['summary']))
sys.exit(1 if report['summary']['failed'] else 0)
PY
test "$failed" -eq 0
