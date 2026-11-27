#!/usr/bin/env bash
# OFFLINE / DISPOSABLE Asset Exchange PostgreSQL 16+ TEST ONLY.
# DOES NOT create or deploy a DB; operator must provision a clean local scratch
# cluster and private data directory. NEVER use GPUbnb Core or a real DB.
set -euo pipefail

verify_socket_before_migrations() {
if [[ "${PRL_SCRATCH_ACK:-}" != "DISPOSABLE_EXCHANGE_DB_ONLY" ]]; then
  echo "REFUSED: set PRL_SCRATCH_ACK=DISPOSABLE_EXCHANGE_DB_ONLY" >&2
  exit 2
fi
if [[ ! "${PGHOST:-}" =~ ^/tmp/gpubnb-prl-scratch-[A-Za-z0-9._-]+/socket$ ]] ||
   [[ ! "${PGDATABASE:-}" =~ ^prl_scratch_[A-Za-z0-9_]+$ ]] ||
   [[ ! "${PGPORT:-}" =~ ^[0-9]{1,5}$ ]] ||
   (( 10#${PGPORT:-0} < 1024 || 10#${PGPORT:-0} > 65535 )) ||
   [[ -z "${PGUSER:-}" ]] ||
   [[ -z "${PRL_SCRATCH_DATA_DIR:-}" ]]; then
  echo "REFUSED: require a private /tmp/.../socket, matching PGDATA," >&2
  echo "         an explicit prl_scratch_* database, port and user." >&2
  exit 2
fi
for connection_override in PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS; do
  if [[ -n "${!connection_override:-}" ]]; then
    echo "REFUSED: ${connection_override} can override the isolated connection." >&2
    exit 2
  fi
done
if [[ -n "${DATABASE_URL:-}" ]] || [[ -n "${ASSET_EXCHANGE_DATABASE_URL:-}" ]]; then
  echo "REFUSED: shared/real database environment variables are set." >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "REFUSED: PostgreSQL psql unavailable; no package install is attempted." >&2
  exit 2
fi
if [[ ! -f asset-exchange/db/migrations/011_prl_accept_replay_quarantine.sql ]] ||
   [[ ! -f asset-exchange/db/migrations/012_idempotency_replay_hardening.sql ]]; then
  echo "REFUSED: run only from the Exchange PRL replay lab checkout." >&2
  exit 2
fi

expected_data_dir="${PGHOST%/socket}/data"
if [[ "$PRL_SCRATCH_DATA_DIR" != "$expected_data_dir" ]]; then
  echo "REFUSED: socket and PostgreSQL data directory must share a private root." >&2
  exit 2
fi
scratch_uid="$(id -u)"
for private_dir in "$PGHOST" "$PRL_SCRATCH_DATA_DIR"; do
  if [[ ! -d "$private_dir" || -L "$private_dir" ]]; then
    echo "REFUSED: private socket/data directory is missing or is a symlink." >&2
    exit 2
  fi
  if [[ "$(stat -c '%u:%a' -- "$private_dir")" != "${scratch_uid}:700" ]]; then
    echo "REFUSED: private socket/data directories must be owned mode 0700." >&2
    exit 2
  fi
done

psql_scratch() {
  psql -X -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" \
    -U "$PGUSER" -d "$PGDATABASE" "$@"
}
actual_db="$(psql_scratch -Atqc 'SELECT current_database()')"
if [[ "$actual_db" != "$PGDATABASE" ]]; then
  echo "REFUSED: connected to unexpected database." >&2
  exit 2
fi
if [[ "$(psql_scratch -Atqc "SELECT CASE WHEN inet_server_addr() IS NULL THEN 'unix' ELSE 'tcp' END")" != "unix" ]]; then
  echo "REFUSED: database connection is not using a Unix-domain socket." >&2
  exit 2
fi
actual_data_dir="$(psql_scratch -Atqc 'SHOW data_directory')"
if [[ "$(readlink -f -- "$actual_data_dir")" != "$(readlink -f -- "$PRL_SCRATCH_DATA_DIR")" ]]; then
  echo "REFUSED: connected PostgreSQL data directory does not match PGDATA." >&2
  exit 2
fi
if [[ -n "$(psql_scratch -Atqc 'SHOW listen_addresses')" ]]; then
  echo "REFUSED: scratch PostgreSQL server must not listen on TCP." >&2
  exit 2
fi
if [[ "$(psql_scratch -Atqc 'SHOW unix_socket_directories')" != "$PGHOST" ]]; then
  echo "REFUSED: server Unix socket directory does not match PGHOST." >&2
  exit 2
fi
if [[ "$(psql_scratch -Atqc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" != "$PGUSER" ]]; then
  echo "REFUSED: scratch database must be owned by the explicit test role." >&2
  exit 2
fi
if [[ "$(psql_scratch -Atqc 'SELECT pg_is_in_recovery()')" != "f" ]]; then
  echo "REFUSED: scratch server must be a standalone primary." >&2
  exit 2
fi
if [[ "$(psql_scratch -Atqc 'SELECT count(*) FROM pg_database WHERE datistemplate = FALSE')" != "2" ]]; then
  echo "REFUSED: scratch cluster contains unexpected non-template databases." >&2
  exit 2
fi
if [[ "$(psql_scratch -Atqc "SELECT count(*) FROM pg_namespace WHERE nspname='asset_exchange'")" != 0 ]]; then
  echo "REFUSED: Exchange schema already exists; scratch DB must be empty." >&2
  exit 2
fi
if [[ "$(psql_scratch -Atqc "SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast','public')")" != 0 ]] ||
   [[ "$(psql_scratch -Atqc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")" != 0 ]] ||
   [[ "$(psql_scratch -Atqc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")" != 0 ]]; then
  echo "REFUSED: scratch database contains unrelated user objects." >&2
  exit 2
fi
if [[ "$(psql_scratch -Atqc 'SHOW server_version_num')" -lt 160000 ]]; then
  echo "REFUSED: PostgreSQL 16+ required." >&2
  exit 2
fi
}

run_replay_cases() {
echo "[PRL scratch] Applying 001..009 in the private disposable DB"
for migration in asset-exchange/db/migrations/00[1-9]_*.sql; do
  [[ -f "$migration" ]] || { echo "Missing migration" >&2; exit 1; }
  echo "  $migration"
  psql_scratch -f "$migration" >/dev/null
done

echo "[PRL scratch] Seeding fake historical records BEFORE quarantine"
psql_scratch -f asset-exchange/db/test/prl_scratch_historical_before_010.sql >/dev/null

echo "[PRL scratch] Applying migrations 010/011/012 ONLY in this disposable DB"
psql_scratch -f asset-exchange/db/migrations/010_prl_historical_offer_quarantine.sql >/dev/null
psql_scratch -f asset-exchange/db/migrations/011_prl_accept_replay_quarantine.sql >/dev/null
psql_scratch -f asset-exchange/db/migrations/012_idempotency_replay_hardening.sql >/dev/null

echo "[PRL scratch] Checking PRL replay, SQL triggers and non-PRL behaviour"
psql_scratch -f asset-exchange/db/test/prl_scratch_accept_replay_after_011.sql
echo "[PRL scratch] Checking PostgreSQL-native publication, cancellation and terms replay"
psql_scratch -f asset-exchange/db/test/idempotency_replay_after_012.sql
psql_scratch -f asset-exchange/db/test/prl_atomicity.sql
echo "[PRL scratch] Replay and atomicity assertions passed."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  verify_socket_before_migrations
  run_replay_cases
fi
