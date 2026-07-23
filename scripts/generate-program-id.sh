#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYPAIR="${1:-$ROOT/keys/gpu_escrow-keypair.json}"
mkdir -p "$(dirname "$KEYPAIR")"
command -v solana-keygen >/dev/null || { echo 'solana-keygen missing'; exit 1; }
[ ! -e "$KEYPAIR" ] || { echo "Refusing to overwrite $KEYPAIR"; exit 1; }
solana-keygen new --no-bip39-passphrase --outfile "$KEYPAIR"
PROGRAM_ID="$(solana-keygen pubkey "$KEYPAIR")"
python3 "$ROOT/scripts/sync-program-id.py" "$PROGRAM_ID"
echo "Program ID synchronized: $PROGRAM_ID"
echo "BACK UP $KEYPAIR OFFLINE. NEVER COMMIT IT."
