#!/usr/bin/env bash
# OFFLINE / DISPOSABLE Asset Exchange PostgreSQL 16+ TEST ONLY.
# DOES NOT create or deploy a DB; operator must provision a clean local scratch
# cluster with a unique socket directory. NEVER use GPUbnb Core or a real DB.
set -euo pipefail

if [[ "${PRL_SCRATCH_ACK:-}" != "DISPOSABLE_EXCHANGE_DB_ONLY" ]]; then
  echo "REFUSED: set PRL_SCRATCH_ACK=DISPOSABLE_EXCHANGE_DB_ONLY" >&2
  exit 2
fi
if [[ "${PGHOST:-}" != /tmp/gpubnb-prl-scratch-* ]] ||
   [[ "${PGDATABASE:-}" != prl_scratch_* ]] ||
   [[ -z "${PGPORT:-}" ]] ||
   [[ -z "${PGUSER:-}" ]]; then
  echo "REFUSED: require a dedicated /tmp/gpubnb-prl-scratch-* Unix socket," >&2
  echo "         an explicit prl_scratch_* DB, PGPORT and PGUSER." >&2
  exit 2
fi
if [[ -n "${DATABASE_URL:-}" ]] || [[ -n "${ASSET_EXCHANGE_DATABASE_URL:-}" ]]; then
  echo "REFUSED: shared/real database environment variables are set." >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "REFUSED: PostgreSQL psql unavailable; no package install is attempted." >&2
  exit 2
fi
if [[ ! -f asset-exchange/db/migrations/011_prl_accept_replay_quarantine.sql ]]; then
  echo "REFUSED: run only from the Exchange PRL replay lab checkout." >&2
  exit 2
fi

psql_scratch() {
  psql -X -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" \
    -U "$PGUSER" -d "$PGDATABASE" "$@"
}
actual_db="$(psql_scratch -Atqc 'SELECT current_database()')"
if [[ "$actual_db" != "$PGDATABASE" ]]; then
  echo "REFUSED: connected to unexpected database." >&2
  exit 2
fi
if [[ "$(psql_scratch -Atqc "SELECT count(*) FROM pg_namespace WHERE nspname='asset_exchange'")" != 0 ]]; then
  echo "REFUSED: Exchange schema already exists; scratch DB must be empty." >&2
  exit 2
fi
if [[ "$(psql_scratch -Atqc 'SHOW server_version_num')" -lt 160000 ]]; then
  echo "REFUSED: PostgreSQL 16+ required." >&2
  exit 2
fi

echo "[PRL scratch] Applying 001..009 in the private disposable DB"
for migration in asset-exchange/db/migrations/00[1-9]_*.sql; do
  [[ -f "$migration" ]] || { echo "Missing migration" >&2; exit 1; }
  psql_scratch -f "$migration" >/dev/null
done

echo "[PRL scratch] Seeding fake historical records BEFORE quarantine"
psql_scratch -f asset-exchange/db/test/prl_scratch_historical_before_010.sql >/dev/null

echo "[PRL scratch] Applying migrations 010/011 ONLY in this disposable DB"
psql_scratch -f asset-exchange/db/migrations/010_prl_historical_offer_quarantine.sql >/dev/null
psql_scratch -f asset-exchange/db/migrations/011_prl_accept_replay_quarantine.sql >/dev/null

echo "[PRL scratch] Checking PRL replay, SQL triggers and non-PRL behaviour"
psql_scratch -f asset-exchange/db/test/prl_scratch_accept_replay_after_011.sql
echo "[PRL scratch] Completed without a production connection."
echo "[PRL scratch] Dispose of scratch cluster/database independently."
