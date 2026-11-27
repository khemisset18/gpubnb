#!/usr/bin/env bash
set -euo pipefail

verify_socket_before_races() {
: "${PG_IMAGE:?PG_IMAGE is required}"
if [[ "${PRL_SCRATCH_ACK:-}" != "DISPOSABLE_EXCHANGE_DB_ONLY" ]]; then
  echo "REFUSED: set PRL_SCRATCH_ACK=DISPOSABLE_EXCHANGE_DB_ONLY" >&2
  exit 2
fi
if [[ ! "${PGHOST:-}" =~ ^/tmp/gpubnb-prl-scratch-[A-Za-z0-9._-]+/socket$ ]] ||
   [[ ! "${PGDATABASE:-}" =~ ^prl_scratch_[A-Za-z0-9_]+$ ]] ||
   [[ ! "${PGPORT:-}" =~ ^[0-9]{1,5}$ ]] ||
   (( 10#${PGPORT:-0} < 1024 || 10#${PGPORT:-0} > 65535 )) ||
   [[ -z "${PGUSER:-}" ]] || [[ -z "${PGPASSWORD:-}" ]] ||
   [[ -z "${PRL_SCRATCH_DATA_DIR:-}" ]]; then
  echo "REFUSED: require a private socket, PGDATA, port, role and prl_scratch_* database." >&2
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
expected_data_dir="${PGHOST%/socket}/data"
if [[ "$PRL_SCRATCH_DATA_DIR" != "$expected_data_dir" ]]; then
  echo "REFUSED: socket and PostgreSQL data directory must share a private root." >&2
  exit 2
fi
scratch_uid="$(id -u)"
for private_dir in "$PGHOST" "$PRL_SCRATCH_DATA_DIR"; do
  if [[ ! -d "$private_dir" || -L "$private_dir" ]] ||
     [[ "$(stat -c '%u:%a' -- "$private_dir")" != "${scratch_uid}:700" ]]; then
    echo "REFUSED: private socket/data directories must be owned mode 0700." >&2
    exit 2
  fi
done

psql_ci() {
  docker run --rm -i --network none \
    --user "$(id -u):$(id -g)" \
    --mount "type=bind,source=${PGHOST},target=${PGHOST}" \
    -e PGPASSWORD="${PGPASSWORD}" \
    -e PGHOSTADDR= -e PGSERVICE= -e PGSERVICEFILE= -e PGOPTIONS= \
    "${PG_IMAGE}" \
    psql -v ON_ERROR_STOP=1 \
      -h "${PGHOST}" -p "${PGPORT}" \
      -U "${PGUSER}" -d "${PGDATABASE}" "$@"
}

assert_scratch_connection() {
  if [[ "$(psql_ci -Atqc 'SELECT current_database()')" != "$PGDATABASE" ]]; then
    echo "REFUSED: connected to an unexpected database." >&2
    exit 2
  fi
  if [[ "$(psql_ci -Atqc "SELECT CASE WHEN inet_server_addr() IS NULL THEN 'unix' ELSE 'tcp' END")" != "unix" ]]; then
    echo "REFUSED: connection is not using a Unix-domain socket." >&2
    exit 2
  fi
  actual_data_dir="$(psql_ci -Atqc 'SHOW data_directory')"
  if [[ "$(readlink -f -- "$actual_data_dir")" != "$(readlink -f -- "$PRL_SCRATCH_DATA_DIR")" ]]; then
    echo "REFUSED: PostgreSQL data directory is not the explicit scratch PGDATA." >&2
    exit 2
  fi
  if [[ -n "$(psql_ci -Atqc 'SHOW listen_addresses')" ]] ||
     [[ "$(psql_ci -Atqc 'SHOW unix_socket_directories')" != "$PGHOST" ]]; then
    echo "REFUSED: server must listen only on the private scratch socket." >&2
    exit 2
  fi
  if [[ "$(psql_ci -Atqc 'SHOW server_version_num')" -lt 160000 ]]; then
    echo "REFUSED: PostgreSQL 16+ required." >&2
    exit 2
  fi
  if [[ "$(psql_ci -Atqc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='asset_exchange' AND ((p.proname='publish_offer_atomic' AND p.pronargs=18 AND pg_get_functiondef(p.oid) LIKE '%idempotency replay publication identity mismatch%') OR (p.proname='cancel_offer_atomic' AND p.pronargs=7 AND pg_get_functiondef(p.oid) LIKE '%idempotency replay cancellation identity mismatch%') OR (p.proname='submit_trade_terms_signature_atomic' AND p.pronargs=8 AND pg_get_functiondef(p.oid) LIKE '%idempotency replay terms identity mismatch%'))")" != "3" ]]; then
    echo "REFUSED: migration 012 replay-hardening functions are not installed." >&2
    exit 2
  fi
  if [[ "$(psql_ci -Atqc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" != "$PGUSER" ]] ||
     [[ "$(psql_ci -Atqc 'SELECT count(*) FROM pg_database WHERE datistemplate = FALSE')" != "2" ]] ||
     [[ "$(psql_ci -Atqc "SELECT count(*) FROM pg_namespace WHERE nspname='asset_exchange'")" != "1" ]] ||
     [[ "$(psql_ci -Atqc "SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast','public','asset_exchange')")" != "0" ]]; then
    echo "REFUSED: database or server is not the isolated Exchange scratch target." >&2
    exit 2
  fi
}
assert_scratch_connection
}

reset_fixture() {
  psql_ci < asset-exchange/db/test/fixture.sql >/dev/null
}

assert_scalar() {
  local sql="$1"
  local expected="$2"
  local actual
  actual="$(printf '%s\n' "${sql}" | psql_ci -Atq)"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "ASSERTION FAILED"
    echo "SQL: ${sql}"
    echo "expected: ${expected}"
    echo "actual: ${actual}"
    exit 1
  fi
}

wait_for_sleeping_winner() {
  for (( attempt=0; attempt<100; attempt++ )); do
    if [[ "$(psql_ci -Atqc "SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='PgSleep')")" == t ]]; then return; fi
    sleep 0.02
  done
  echo "Race fixture never observed the winning session holding its transaction open" >&2
  return 1
}

run_concurrency_cases() (
  race_logs="$(mktemp -d)"
  trap 'rm -rf -- "$race_logs"' EXIT
echo "[1/10] accept-vs-accept"
reset_fixture

(
  cat <<'SQL' | psql_ci >"$race_logs/ae-accept-winner.log" 2>&1
BEGIN;
SELECT singleton FROM asset_exchange.operator_state
WHERE singleton = TRUE
FOR UPDATE;
SELECT pg_sleep(1);
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'trade-00000001',
  'taker:test:001',
  repeat('a', 64),
  7,
  repeat('b', 64),
  decode('11', 'hex'),
  'accept-key-00000001',
  repeat('c', 64)
);
COMMIT;
SQL
) &
winner_pid=$!

wait_for_sleeping_winner
set +e
cat <<'SQL' | psql_ci >"$race_logs/ae-accept-loser.log" 2>&1
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'trade-00000002',
  'taker:test:002',
  repeat('a', 64),
  7,
  repeat('d', 64),
  decode('22', 'hex'),
  'accept-key-00000002',
  repeat('e', 64)
);
SQL
loser_status=$?
set -e

wait "${winner_pid}"

if [[ "${loser_status}" -eq 0 ]]; then
  echo "ERROR: second concurrent accept unexpectedly succeeded"
  cat "$race_logs/ae-accept-loser.log"
  exit 1
fi
grep -Fq 'offer is not open' "$race_logs/ae-accept-loser.log"

assert_scalar "SELECT count(*) FROM asset_exchange.trades WHERE offer_id='offer-00000001';" "1"
assert_scalar "SELECT state FROM asset_exchange.offers WHERE offer_id='offer-00000001';" "CONSUMED"
assert_scalar "SELECT accepted_trade_id FROM asset_exchange.offers WHERE offer_id='offer-00000001';" "trade-00000001"

echo "[2/10] accept-vs-cancel"
reset_fixture

(
  cat <<'SQL' | psql_ci >"$race_logs/ae-cancel-winner.log" 2>&1
BEGIN;
SELECT offer_id FROM asset_exchange.offers
WHERE offer_id = 'offer-00000001'
FOR UPDATE;
SELECT pg_sleep(1);
SELECT * FROM asset_exchange.cancel_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'maker:test:001',
  repeat('c', 64),
  decode('33', 'hex'),
  'cancel-key-0000001',
  repeat('f', 64)
);
COMMIT;
SQL
) &
cancel_pid=$!

wait_for_sleeping_winner
set +e
cat <<'SQL' | psql_ci >"$race_logs/ae-accept-after-cancel.log" 2>&1
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'trade-00000003',
  'taker:test:003',
  repeat('a', 64),
  7,
  repeat('1', 64),
  decode('33', 'hex'),
  'accept-key-00000003',
  repeat('2', 64)
);
SQL
accept_after_cancel_status=$?
set -e

wait "${cancel_pid}"

if [[ "${accept_after_cancel_status}" -eq 0 ]]; then
  echo "ERROR: accept unexpectedly succeeded after cancellation won the lock race"
  cat "$race_logs/ae-accept-after-cancel.log"
  exit 1
fi
grep -Fq 'offer is not open' "$race_logs/ae-accept-after-cancel.log"

assert_scalar "SELECT state FROM asset_exchange.offers WHERE offer_id='offer-00000001';" "CANCELLED"
assert_scalar "SELECT count(*) FROM asset_exchange.trades WHERE offer_id='offer-00000001';" "0"

echo "[3/10] idempotent retry"
reset_fixture
cat <<'SQL' | psql_ci >/dev/null
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'trade-00000004',
  'taker:test:004',
  repeat('a', 64),
  7,
  repeat('3', 64),
  decode('44', 'hex'),
  'accept-key-00000004',
  repeat('4', 64)
);
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'trade-00000004',
  'taker:test:004',
  repeat('a', 64),
  7,
  repeat('3', 64),
  decode('44', 'hex'),
  'accept-key-00000004',
  repeat('4', 64)
);
SQL
assert_scalar "SELECT count(*) FROM asset_exchange.trades WHERE trade_id='trade-00000004';" "1"
assert_scalar "SELECT count(*) FROM asset_exchange.trade_events WHERE trade_id='trade-00000004';" "1"

echo "[4/10] concurrent identical acceptance is durably idempotent"
reset_fixture
(
  cat <<'SQL' | psql_ci >"$race_logs/ae-identical-replay-first.log" 2>&1
BEGIN;
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'trade-00000004',
  'taker:test:004',
  repeat('a', 64),
  7,
  repeat('3', 64),
  decode('44', 'hex'),
  'accept-key-concurrent01',
  repeat('4', 64)
);
SELECT pg_sleep(1);
COMMIT;
SQL
) &
first_pid=$!

wait_for_sleeping_winner
set +e
cat <<'SQL' | psql_ci >"$race_logs/ae-identical-replay-second.log" 2>&1
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'trade-00000004',
  'taker:test:004',
  repeat('a', 64),
  7,
  repeat('3', 64),
  decode('44', 'hex'),
  'accept-key-concurrent01',
  repeat('4', 64)
);
SQL
second_status=$?
set -e
if ! wait "${first_pid}"; then
  echo "ERROR: first concurrent idempotent acceptance failed"
  cat "$race_logs/ae-identical-replay-first.log"
  exit 1
fi
if [[ "${second_status}" -ne 0 ]]; then
  echo "ERROR: second concurrent idempotent acceptance failed"
  cat "$race_logs/ae-identical-replay-second.log"
  exit 1
fi
assert_scalar "SELECT count(*) FROM asset_exchange.trades WHERE trade_id='trade-00000004';" "1"
assert_scalar "SELECT count(*) FROM asset_exchange.trade_events WHERE trade_id='trade-00000004';" "1"
assert_scalar "SELECT count(*) FROM asset_exchange.idempotency_records WHERE idempotency_key='accept-key-concurrent01' AND result_ref='trade-00000004';" "1"

echo "[5/10] idempotency key mismatch fails"
set +e
cat <<'SQL' | psql_ci >"$race_logs/ae-idempotency-mismatch.log" 2>&1
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'trade-00000004',
  'taker:test:004',
  repeat('a', 64),
  7,
  repeat('3', 64),
  decode('44', 'hex'),
  'accept-key-concurrent01',
  repeat('9', 64)
);
SQL
mismatch_status=$?
set -e
if [[ "${mismatch_status}" -eq 0 ]]; then
  echo "ERROR: idempotency key reused with different hash unexpectedly succeeded"
  exit 1
fi

grep -Fq 'idempotency key reused with different request' "$race_logs/ae-idempotency-mismatch.log"

echo "[6/10] transition epoch blocks new acceptance"
reset_fixture
cat <<'SQL' | psql_ci >/dev/null
UPDATE asset_exchange.operator_state
SET mode='TRANSITION',
    target_mode='CONFORMITE',
    policy_epoch=8,
    new_offers_enabled=FALSE,
    new_accepts_enabled=FALSE,
    new_locks_enabled=FALSE
WHERE singleton=TRUE;
SQL

set +e
cat <<'SQL' | psql_ci >"$race_logs/ae-transition-block.log" 2>&1
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'trade-00000005',
  'taker:test:005',
  repeat('a', 64),
  7,
  repeat('5', 64),
  decode('55', 'hex'),
  'accept-key-00000005',
  repeat('6', 64)
);
SQL
transition_status=$?
set -e
if [[ "${transition_status}" -eq 0 ]]; then
  echo "ERROR: stale acceptance succeeded during TRANSITION"
  exit 1
fi
grep -Fq 'acceptance blocked by current policy epoch/state' "$race_logs/ae-transition-block.log"
assert_scalar "SELECT count(*) FROM asset_exchange.trades;" "0"
assert_scalar "SELECT state FROM asset_exchange.offers WHERE offer_id='offer-00000001';" "OPEN"

echo "[7/10] financial immutability guards"
reset_fixture

set +e
printf "%s\n" "UPDATE asset_exchange.offers SET give_amount_atomic=1 WHERE offer_id='offer-00000001';" | psql_ci >"$race_logs/ae-mutate-offer.log" 2>&1
mutate_offer_status=$?
set -e
if [[ "${mutate_offer_status}" -eq 0 ]]; then
  echo "ERROR: signed offer amount mutation unexpectedly succeeded"
  exit 1
fi
grep -Fq 'signed offer fields are immutable' "$race_logs/ae-mutate-offer.log"

cat <<'SQL' | psql_ci >/dev/null
SELECT * FROM asset_exchange.cancel_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'maker:test:001',
  repeat('c', 64),
  decode('33', 'hex'),
  'cancel-key-immutable01',
  repeat('f', 64)
);
SQL

set +e
printf "%s\n" "UPDATE asset_exchange.offers SET cancellation_hash=repeat('d',64) WHERE offer_id='offer-00000001';" | psql_ci >"$race_logs/ae-mutate-cancel.log" 2>&1
mutate_cancel_status=$?
set -e
if [[ "${mutate_cancel_status}" -eq 0 ]]; then
  echo "ERROR: signed cancellation evidence mutation unexpectedly succeeded"
  exit 1
fi
grep -Fq 'signed cancellation evidence is immutable' "$race_logs/ae-mutate-cancel.log"

reset_fixture
cat <<'SQL' | psql_ci >/dev/null
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01',
  'offer-00000001',
  'trade-immutable01',
  'taker:test:immutable',
  repeat('a', 64),
  7,
  repeat('3', 64),
  decode('44', 'hex'),
  'accept-key-immutable01',
  repeat('4', 64)
);
SQL

set +e
printf "%s\n" "UPDATE asset_exchange.trades SET acceptance_hash=repeat('e',64) WHERE trade_id='trade-immutable01';" | psql_ci >"$race_logs/ae-mutate-acceptance.log" 2>&1
mutate_acceptance_status=$?
set -e
if [[ "${mutate_acceptance_status}" -eq 0 ]]; then
  echo "ERROR: acceptance evidence mutation unexpectedly succeeded"
  exit 1
fi
grep -Fq 'signed trade identity/acceptance fields are immutable' "$race_logs/ae-mutate-acceptance.log"

cat <<'SQL' | psql_ci >/dev/null
UPDATE asset_exchange.trades
SET terms_hash=repeat('7',64),
    signed_terms_a=decode('aa','hex'),
    signed_terms_b=decode('bb','hex')
WHERE trade_id='trade-immutable01';
SQL

set +e
printf "%s\n" "UPDATE asset_exchange.trades SET terms_hash=repeat('8',64) WHERE trade_id='trade-immutable01';" | psql_ci >"$race_logs/ae-mutate-terms.log" 2>&1
mutate_terms_status=$?
set -e
if [[ "${mutate_terms_status}" -eq 0 ]]; then
  echo "ERROR: finalized terms hash rewrite unexpectedly succeeded"
  exit 1
fi
grep -Fq 'trade terms hash is write-once' "$race_logs/ae-mutate-terms.log"

set +e
printf "%s\n" "UPDATE asset_exchange.trade_events SET evidence='{}'::jsonb WHERE trade_id='trade-immutable01';" | psql_ci >"$race_logs/ae-mutate-event.log" 2>&1
mutate_event_status=$?
set -e
if [[ "${mutate_event_status}" -eq 0 ]]; then
  echo "ERROR: append-only trade event mutation unexpectedly succeeded"
  exit 1
fi
grep -Fq 'trade events are append-only' "$race_logs/ae-mutate-event.log"

echo "[8/10] concurrent identical publication is durably idempotent"
reset_fixture
(
  cat <<'SQL' | psql_ci -At >"$race_logs/ae-publish-replay-first.log" 2>&1
BEGIN;
SELECT status, offer_id FROM asset_exchange.publish_offer_atomic(
  'ae-test-01','offer-publish-concurrent01','maker:test:001',repeat('9',64),
  decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
  'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100,
  'litecoin|regtest|NATIVE|LTC_NATIVE|8',250,'ABCDEFGHIJKLMNOP',7,
  'default-taker-v1',1,'2030-01-01T00:00:00Z',
  'publish-concurrent-key01',repeat('c',64)
);
SELECT pg_sleep(1);
COMMIT;
SQL
) &
publish_first_pid=$!
wait_for_sleeping_winner
set +e
cat <<'SQL' | psql_ci -At >"$race_logs/ae-publish-replay-second.log" 2>&1
SELECT status, offer_id FROM asset_exchange.publish_offer_atomic(
  'ae-test-01','offer-publish-concurrent01','maker:test:001',repeat('9',64),
  decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
  'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100,
  'litecoin|regtest|NATIVE|LTC_NATIVE|8',250,'ABCDEFGHIJKLMNOP',7,
  'default-taker-v1',1,'2030-01-01T00:00:00Z',
  'publish-concurrent-key01',repeat('c',64)
);
SQL
publish_second_status=$?
set -e
if ! wait "${publish_first_pid}" || [[ "${publish_second_status}" -ne 0 ]]; then
  echo "ERROR: concurrent idempotent publication failed"
  cat "$race_logs/ae-publish-replay-first.log" "$race_logs/ae-publish-replay-second.log"
  exit 1
fi
grep -Fq 'OPEN|offer-publish-concurrent01' "$race_logs/ae-publish-replay-first.log"
grep -Fq 'OPEN|offer-publish-concurrent01' "$race_logs/ae-publish-replay-second.log"
assert_scalar "SELECT count(*) FROM asset_exchange.offers WHERE offer_id='offer-publish-concurrent01';" "1"
assert_scalar "SELECT count(*) FROM asset_exchange.idempotency_records WHERE idempotency_key='publish-concurrent-key01';" "1"

echo "[9/10] concurrent identical cancellation is durably idempotent"
reset_fixture
cat <<'SQL' | psql_ci >/dev/null
SELECT * FROM asset_exchange.publish_offer_atomic(
  'ae-test-01','offer-cancel-concurrent01','maker:test:001',repeat('9',64),
  decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
  'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100,
  'litecoin|regtest|NATIVE|LTC_NATIVE|8',250,'ABCDEFGHIJKLMNOP',7,
  'default-taker-v1',1,'2030-01-01T00:00:00Z',
  'publish-cancel-source01',repeat('b',64)
);
SQL
(
  cat <<'SQL' | psql_ci -At >"$race_logs/ae-cancel-replay-first.log" 2>&1
BEGIN;
SELECT status, offer_id FROM asset_exchange.cancel_offer_atomic(
  'ae-test-01','offer-cancel-concurrent01','maker:test:001',repeat('d',64),
  decode('dd','hex'),'cancel-concurrent-key01',repeat('e',64)
);
SELECT pg_sleep(1);
COMMIT;
SQL
) &
cancel_first_pid=$!
wait_for_sleeping_winner
set +e
cat <<'SQL' | psql_ci -At >"$race_logs/ae-cancel-replay-second.log" 2>&1
SELECT status, offer_id FROM asset_exchange.cancel_offer_atomic(
  'ae-test-01','offer-cancel-concurrent01','maker:test:001',repeat('d',64),
  decode('dd','hex'),'cancel-concurrent-key01',repeat('e',64)
);
SQL
cancel_second_status=$?
set -e
if ! wait "${cancel_first_pid}" || [[ "${cancel_second_status}" -ne 0 ]]; then
  echo "ERROR: concurrent idempotent cancellation failed"
  cat "$race_logs/ae-cancel-replay-first.log" "$race_logs/ae-cancel-replay-second.log"
  exit 1
fi
grep -Fq 'CANCELLED|offer-cancel-concurrent01' "$race_logs/ae-cancel-replay-first.log"
grep -Fq 'CANCELLED|offer-cancel-concurrent01' "$race_logs/ae-cancel-replay-second.log"
assert_scalar "SELECT state FROM asset_exchange.offers WHERE offer_id='offer-cancel-concurrent01';" "CANCELLED"
assert_scalar "SELECT count(*) FROM asset_exchange.idempotency_records WHERE idempotency_key='cancel-concurrent-key01';" "1"

echo "[10/10] concurrent identical terms signature is durably idempotent"
reset_fixture
cat <<'SQL' | psql_ci >/dev/null
SELECT * FROM asset_exchange.publish_offer_atomic(
  'ae-test-01','offer-terms-concurrent01','maker:test:001',repeat('9',64),
  decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
  'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100,
  'litecoin|regtest|NATIVE|LTC_NATIVE|8',250,'ABCDEFGHIJKLMNOP',7,
  'default-taker-v1',1,'2030-01-01T00:00:00Z',
  'publish-terms-source01',repeat('b',64)
);
SELECT * FROM asset_exchange.accept_offer_atomic(
  'ae-test-01','offer-terms-concurrent01','trade-terms-concurrent01',
  'taker:test:terms',repeat('9',64),7,repeat('c',64),decode('cc','hex'),
  'accept-terms-source001',repeat('d',64)
);
SQL
(
  cat <<'SQL' | psql_ci -At >"$race_logs/ae-terms-replay-first.log" 2>&1
BEGIN;
SELECT status, trade_id FROM asset_exchange.submit_trade_terms_signature_atomic(
  'ae-test-01','trade-terms-concurrent01','maker:test:001','MAKER',repeat('e',64),
  decode('ee','hex'),'terms-concurrent-key01',repeat('f',64)
);
SELECT pg_sleep(1);
COMMIT;
SQL
) &
terms_first_pid=$!
wait_for_sleeping_winner
set +e
cat <<'SQL' | psql_ci -At >"$race_logs/ae-terms-replay-second.log" 2>&1
SELECT status, trade_id FROM asset_exchange.submit_trade_terms_signature_atomic(
  'ae-test-01','trade-terms-concurrent01','maker:test:001','MAKER',repeat('e',64),
  decode('ee','hex'),'terms-concurrent-key01',repeat('f',64)
);
SQL
terms_second_status=$?
set -e
if ! wait "${terms_first_pid}" || [[ "${terms_second_status}" -ne 0 ]]; then
  echo "ERROR: concurrent idempotent terms signature failed"
  cat "$race_logs/ae-terms-replay-first.log" "$race_logs/ae-terms-replay-second.log"
  exit 1
fi
grep -Fq 'ACCEPTED_PENDING_TERMS|trade-terms-concurrent01' "$race_logs/ae-terms-replay-first.log"
grep -Fq 'ACCEPTED_PENDING_TERMS|trade-terms-concurrent01' "$race_logs/ae-terms-replay-second.log"
assert_scalar "SELECT count(*) FROM asset_exchange.trade_events WHERE trade_id='trade-terms-concurrent01';" "2"
assert_scalar "SELECT count(*) FROM asset_exchange.idempotency_records WHERE idempotency_key='terms-concurrent-key01';" "1"

echo "All PostgreSQL concurrency/idempotency/immutability tests passed."
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == true && -z "${PRL_SCRATCH_ACK:-}" ]]; then
    # The PR runner supplies a service endpoint. Run the PRL campaign in a
    # separate initdb cluster owned by the harness, using runner binaries.
    exec python3 "$(dirname "$0")/prl_disposable.py" --pg-bin "$(pg_config --bindir)"
  fi
  verify_socket_before_races
  run_concurrency_cases
fi
