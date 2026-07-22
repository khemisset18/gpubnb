#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
failed=0
check(){ local label="$1"; shift; if "$@"; then echo "OK:   $label"; else echo "FAIL: $label"; failed=1; fi; }
check_not_grep(){ local label="$1" pattern="$2" file="$3"; if grep -q "$pattern" "$file"; then echo "FAIL: $label"; failed=1; else echo "OK:   $label"; fi; }

check_not_grep "Program ID is not Anchor example" 'Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m' programs/gpu_escrow/src/lib.rs
check_not_grep "Anchor.toml has no placeholder" 'REPLACE_WITH_DEPLOYED_PROGRAM_ID' Anchor.toml
if find . -path './apps/api/node_modules' -prune -o \( -name '*keypair*.json' -o -name 'id.json' -o -name '*-wallet.json' \) -print | grep -q .; then echo 'FAIL: no deploy key committed'; failed=1; else echo 'OK:   no deploy key committed'; fi
check "Incident runbook present" test -f docs/INCIDENT_RESPONSE.md
check "External audit report present" test -f audit/evidence/external-audit.pdf
check "Pentest report present" test -f audit/evidence/pentest.pdf
check "Multisig evidence present" test -f audit/evidence/multisig.json
check "Program deployment evidence present" test -f audit/evidence/program.json
if ! scripts/verify-program-id.sh; then failed=1; fi

if (( failed )); then echo 'MAINNET: NO-GO'; exit 1; fi
echo 'MAINNET: automated evidence gates passed; human release approval still required.'
