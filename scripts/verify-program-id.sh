#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID=$(sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' "$ROOT/programs/gpu_escrow/src/lib.rs")
[ -n "$PID" ] || { echo 'No declare_id'; exit 1; }
[ "$PID" != 'Fg6PaFpoGXkYsidMpWxTWqkZq26fPRmKZX54C9V8uB9m' ] || { echo 'Example Program ID remains'; exit 1; }
if [ -n "${PROGRAM_KEYPAIR:-}" ]; then
  ACTUAL=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
  [ "$ACTUAL" = "$PID" ] || { echo "Mismatch: source=$PID keypair=$ACTUAL"; exit 1; }
fi
echo "Program ID OK: $PID"
