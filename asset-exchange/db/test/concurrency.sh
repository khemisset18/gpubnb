#!/usr/bin/env bash
set -euo pipefail

: "${PG_IMAGE:?PG_IMAGE is required}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-asset_exchange}"
PGDATABASE="${PGDATABASE:-asset_exchange}"
PGPASSWORD="${PGPASSWORD:-asset_exchange_ci}"
export PGPASSWORD

psql_ci() {
  docker run --rm -i --network host     -e PGPASSWORD="${PGPASSWORD}"     "${PG_IMAGE}"     psql -v ON_ERROR_STOP=1       -h "${PGHOST}" -p "${PGPORT}"       -U "${PGUSER}" -d "${PGDATABASE}" "$@"
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

echo "[1/5] accept-vs-accept"
reset_fixture

(
  cat <<'SQL' | psql_ci >/tmp/ae-accept-winner.log 2>&1
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

sleep 0.2
set +e
cat <<'SQL' | psql_ci >/tmp/ae-accept-loser.log 2>&1
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
  cat /tmp/ae-accept-loser.log
  exit 1
fi

assert_scalar "SELECT count(*) FROM asset_exchange.trades WHERE offer_id='offer-00000001';" "1"
assert_scalar "SELECT state FROM asset_exchange.offers WHERE offer_id='offer-00000001';" "CONSUMED"
assert_scalar "SELECT accepted_trade_id FROM asset_exchange.offers WHERE offer_id='offer-00000001';" "trade-00000001"

echo "[2/5] accept-vs-cancel"
reset_fixture

(
  cat <<'SQL' | psql_ci >/tmp/ae-cancel-winner.log 2>&1
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

sleep 0.2
set +e
cat <<'SQL' | psql_ci >/tmp/ae-accept-after-cancel.log 2>&1
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
  cat /tmp/ae-accept-after-cancel.log
  exit 1
fi

assert_scalar "SELECT state FROM asset_exchange.offers WHERE offer_id='offer-00000001';" "CANCELLED"
assert_scalar "SELECT count(*) FROM asset_exchange.trades WHERE offer_id='offer-00000001';" "0"

echo "[3/5] idempotent retry"
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

echo "[4/5] idempotency key mismatch fails"
set +e
cat <<'SQL' | psql_ci >/tmp/ae-idempotency-mismatch.log 2>&1
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
  repeat('9', 64)
);
SQL
mismatch_status=$?
set -e
if [[ "${mismatch_status}" -eq 0 ]]; then
  echo "ERROR: idempotency key reused with different hash unexpectedly succeeded"
  exit 1
fi

echo "[5/5] transition epoch blocks new acceptance"
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
cat <<'SQL' | psql_ci >/tmp/ae-transition-block.log 2>&1
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
assert_scalar "SELECT count(*) FROM asset_exchange.trades;" "0"
assert_scalar "SELECT state FROM asset_exchange.offers WHERE offer_id='offer-00000001';" "OPEN"

echo "All PostgreSQL concurrency/idempotency tests passed."
