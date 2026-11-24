-- Native PostgreSQL regression scenario for migration 012.
-- Synthetic records only; run solely after 001-012 in the disposable scratch DB.
-- All writes below are rolled back. This is a PostgreSQL test, not a static test.
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = asset_exchange, pg_catalog;

DO $guard$
BEGIN
  IF current_database() !~ '^prl_scratch_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'PRL_TEST_REQUIRES_DISPOSABLE_DATABASE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
      WHERE pronamespace = 'asset_exchange'::regnamespace
        AND proname = 'publish_offer_atomic' AND pronargs = 18)
     OR NOT EXISTS (SELECT 1 FROM pg_proc
      WHERE pronamespace = 'asset_exchange'::regnamespace
        AND proname = 'cancel_offer_atomic' AND pronargs = 7)
     OR NOT EXISTS (SELECT 1 FROM pg_proc
      WHERE pronamespace = 'asset_exchange'::regnamespace
        AND proname = 'submit_trade_terms_signature_atomic' AND pronargs = 8) THEN
    RAISE EXCEPTION 'PRL_TEST_MIGRATION_012_MISSING';
  END IF;
END;
$guard$;

DO $tests$
DECLARE
  v_expiry timestamptz := clock_timestamp() + interval '700 milliseconds';
  v_result_status text;
  v_result_id text;
BEGIN
  UPDATE operator_state SET new_offers_enabled = TRUE, new_accepts_enabled = TRUE
  WHERE singleton = TRUE;

  -- First publication, then an identical retry after its signed expiry.
  SELECT p.status, p.offer_id INTO v_result_status, v_result_id
  FROM publish_offer_atomic(
    'ae-test-01','replay-publish-0001','maker:test:012',repeat('6',64)::char(64),
    decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
    'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100::atomic_u128,
    'litecoin|regtest|NATIVE|LTC_NATIVE|8',250::atomic_u128,
    'ABCDEFGHIJKLMNOP',7,'prl-scratch-policy',1,v_expiry,
    'publish-replay-key-0001',repeat('7',64)::char(64)
  ) AS p;
  IF v_result_status IS DISTINCT FROM 'OPEN' OR v_result_id IS DISTINCT FROM 'replay-publish-0001' THEN
    RAISE EXCEPTION 'publication did not return the new result';
  END IF;
  PERFORM pg_sleep(0.8);
  SELECT p.status, p.offer_id INTO v_result_status, v_result_id
  FROM publish_offer_atomic(
    'ae-test-01','replay-publish-0001','maker:test:012',repeat('6',64)::char(64),
    decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
    'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100::atomic_u128,
    'litecoin|regtest|NATIVE|LTC_NATIVE|8',250::atomic_u128,
    'ABCDEFGHIJKLMNOP',7,'prl-scratch-policy',1,v_expiry,
    'publish-replay-key-0001',repeat('7',64)::char(64)
  ) AS p;
  IF v_result_status IS DISTINCT FROM 'OPEN' OR v_result_id IS DISTINCT FROM 'replay-publish-0001' THEN
    RAISE EXCEPTION 'expired exact publication replay failed';
  END IF;

  -- NULL/malformed hashes and keys must fail before the existing-record branch.
  BEGIN
    PERFORM publish_offer_atomic(
      'ae-test-01','replay-publish-0001','maker:test:012',repeat('6',64)::char(64),
      decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
      'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100::atomic_u128,
      'litecoin|regtest|NATIVE|LTC_NATIVE|8',250::atomic_u128,
      'ABCDEFGHIJKLMNOP',7,'prl-scratch-policy',1,v_expiry,
      'publish-replay-key-0001',NULL
    );
    RAISE EXCEPTION 'expected NULL publication hash refusal';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM publish_offer_atomic(
      'ae-test-01','replay-publish-0001','maker:test:012',repeat('6',64)::char(64),
      decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
      'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100::atomic_u128,
      'litecoin|regtest|NATIVE|LTC_NATIVE|8',250::atomic_u128,
      'ABCDEFGHIJKLMNOP',7,'prl-scratch-policy',1,v_expiry,
      'short-key',repeat('7',64)::char(64)
    );
    RAISE EXCEPTION 'expected malformed publication key refusal';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM publish_offer_atomic(
      'ae-test-01','replay-publish-0001','maker:test:012',repeat('6',64)::char(64),
      decode('aa','hex'),decode('bc','hex'),'TEST_ONLY',
      'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100::atomic_u128,
      'litecoin|regtest|NATIVE|LTC_NATIVE|8',250::atomic_u128,
      'ABCDEFGHIJKLMNOP',7,'prl-scratch-policy',1,v_expiry,
      'publish-replay-key-0001',repeat('7',64)::char(64)
    );
    RAISE EXCEPTION 'expected publication proof mismatch refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('publication identity mismatch' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM publish_offer_atomic(
      'ae-test-01','replay-publish-0001','maker:test:012',repeat('6',64)::char(64),
      decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
      'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100::atomic_u128,
      'litecoin|regtest|NATIVE|LTC_NATIVE|8',250::atomic_u128,
      'ABCDEFGHIJKLMNOP',7,'prl-scratch-policy',1,v_expiry,
      'publish-replay-key-0001',repeat('8',64)::char(64)
    );
    RAISE EXCEPTION 'expected publication request hash mismatch';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;
  BEGIN
    PERFORM publish_offer_atomic(
      'ae-test-01','expired-publish-0001','maker:test:012',repeat('8',64)::char(64),
      decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
      'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100::atomic_u128,
      'litecoin|regtest|NATIVE|LTC_NATIVE|8',250::atomic_u128,
      'ABCDEFGHIJKLMNOP',7,'prl-scratch-policy',1,clock_timestamp()-interval '1 second',
      'publish-expired-key-001',repeat('9',64)::char(64)
    );
    RAISE EXCEPTION 'expected fresh expired publication refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('cannot publish expired offer' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM publish_offer_atomic(
      'ae-test-01','forbidden-prl-0001','maker:test:012',repeat('a',64)::char(64),
      decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
      'pearl|mainnet|NATIVE|PRL_UNVERIFIED|8',100::atomic_u128,
      'litecoin|regtest|NATIVE|LTC_NATIVE|8',250::atomic_u128,
      'ABCDEFGHIJKLMNOP',7,'prl-scratch-policy',1,clock_timestamp()+interval '1 hour',
      'publish-prl-block-key-1',repeat('b',64)::char(64)
    );
    RAISE EXCEPTION 'expected direct SQL PRL publication refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('Pearl' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;

  -- Cancellation replay must match the persisted result, hash and signature.
  PERFORM cancel_offer_atomic(
    'ae-test-01','replay-publish-0001','maker:test:012',repeat('c',64)::char(64),
    decode('cc','hex'),'cancel-replay-key-0001',repeat('d',64)::char(64)
  );
  SELECT c.status,c.offer_id INTO v_result_status,v_result_id
  FROM cancel_offer_atomic(
    'ae-test-01','replay-publish-0001','maker:test:012',repeat('c',64)::char(64),
    decode('cc','hex'),'cancel-replay-key-0001',repeat('d',64)::char(64)
  ) AS c;
  IF v_result_status IS DISTINCT FROM 'CANCELLED' OR v_result_id IS DISTINCT FROM 'replay-publish-0001' THEN
    RAISE EXCEPTION 'exact cancellation replay failed';
  END IF;
  BEGIN
    PERFORM cancel_offer_atomic(
      'ae-test-01','replay-publish-0001','maker:test:012',repeat('c',64)::char(64),
      decode('cd','hex'),'cancel-replay-key-0001',repeat('d',64)::char(64)
    );
    RAISE EXCEPTION 'expected cancellation signature mismatch refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('cancellation identity mismatch' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM cancel_offer_atomic(
      'ae-test-01','replay-publish-0001','maker:test:012',repeat('f',64)::char(64),
      decode('cc','hex'),'cancel-replay-key-0001',repeat('d',64)::char(64)
    );
    RAISE EXCEPTION 'expected cancellation hash mismatch refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('cancellation identity mismatch' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM cancel_offer_atomic('ae-test-01','replay-publish-0001','maker:test:012',
      repeat('c',64),decode('cc','hex'),'cancel-replay-key-0001',repeat('f',64));
    RAISE EXCEPTION 'expected cancellation request hash mismatch';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    PERFORM cancel_offer_atomic(
      'ae-test-01','replay-publish-0001','maker:other:012',repeat('c',64)::char(64),
      decode('cc','hex'),'cancel-replay-key-0001',repeat('d',64)::char(64)
    );
    RAISE EXCEPTION 'expected cross-actor cancellation refusal';
  EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '55000' THEN NULL;
  END;

  -- Accept a separate non-PRL offer and prove durable terms replay.
  PERFORM publish_offer_atomic(
    'ae-test-01','terms-offer-0001','maker:test:terms',repeat('1',64)::char(64),
    decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
    'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100::atomic_u128,
    'litecoin|regtest|NATIVE|LTC_NATIVE|8',250::atomic_u128,
    'QRSTUVWXYZabcdef',7,'prl-scratch-policy',1,clock_timestamp()+interval '1 hour',
    'publish-terms-key-0001',repeat('2',64)::char(64)
  );
  PERFORM accept_offer_atomic(
    'ae-test-01','terms-offer-0001','terms-trade-0001','taker:test:terms',
    repeat('1',64)::char(64),7,repeat('3',64)::char(64),decode('33','hex'),
    'accept-terms-key-0001',repeat('4',64)::char(64)
  );
  SELECT s.status,s.trade_id INTO v_result_status,v_result_id
  FROM submit_trade_terms_signature_atomic(
    'ae-test-01','terms-trade-0001','maker:test:terms','MAKER',
    repeat('5',64)::char(64),decode('55','hex'),
    'terms-maker-key-0001',repeat('6',64)::char(64)
  ) AS s;
  IF v_result_status IS DISTINCT FROM 'ACCEPTED_PENDING_TERMS' OR v_result_id IS DISTINCT FROM 'terms-trade-0001' THEN
    RAISE EXCEPTION 'first terms signature returned unexpected result';
  END IF;
  PERFORM submit_trade_terms_signature_atomic(
    'ae-test-01','terms-trade-0001','maker:test:terms','MAKER',
    repeat('5',64)::char(64),decode('55','hex'),
    'terms-maker-key-0001',repeat('6',64)::char(64)
  );
  IF (SELECT count(*) FROM trade_events WHERE trade_id='terms-trade-0001') <> 2 THEN
    -- one acceptance event plus one terms-signature event
    RAISE EXCEPTION 'exact terms retry created duplicate financial evidence';
  END IF;
  BEGIN
    PERFORM submit_trade_terms_signature_atomic(
      'ae-test-01','terms-trade-0001','maker:test:terms','MAKER',
      repeat('5',64)::char(64),decode('56','hex'),
      'terms-maker-key-0001',repeat('6',64)::char(64)
    );
    RAISE EXCEPTION 'expected terms signature replay mismatch refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('terms identity mismatch' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM submit_trade_terms_signature_atomic(
      'ae-test-01','terms-trade-0001','maker:test:terms','MAKER',
      repeat('5',64)::char(64),decode('55','hex'),
      'terms-maker-key-0001',repeat('7',64)::char(64)
    );
    RAISE EXCEPTION 'expected terms request hash mismatch';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;
  BEGIN
    PERFORM submit_trade_terms_signature_atomic(
      'ae-test-01','terms-trade-0001','maker:test:terms',NULL,
      repeat('5',64)::char(64),decode('55','hex'),
      'terms-null-role-0001',repeat('8',64)::char(64)
    );
    RAISE EXCEPTION 'expected NULL terms role refusal';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$tests$;

ROLLBACK;
