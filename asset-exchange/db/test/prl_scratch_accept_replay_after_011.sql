-- Read-only replay evidence + intentionally rolled-back simulated writes.
-- Run ONLY against a dedicated scratch PostgreSQL DB seeded BEFORE 010.
-- Entire validation runs in a transaction and is rolled back.
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = asset_exchange, pg_catalog;

DO $safety$
BEGIN
  IF current_database() !~ '^prl_scratch_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'PRL_TEST_REQUIRES_DISPOSABLE_DATABASE';
  END IF;
  IF (SELECT count(*) FROM offers WHERE offer_id IN
      ('prl-old-give-0001','prl-old-want-0001',
       'prl-old-other-0001','prl-old-open-0001')) <> 4 THEN
    RAISE EXCEPTION 'PRL_TEST_HISTORICAL_SEED_MISSING';
  END IF;
END;
$safety$;

DO $tests$
DECLARE
  v_status text;
  v_trade text;
  v_case record;
BEGIN
  -- Even when new acceptances are disabled, a legitimate *historical*
  -- non-PRL replay should resolve consistently to its existing trade.
  SELECT a.status, a.trade_id
    INTO v_status, v_trade
    FROM asset_exchange.accept_offer_atomic(
      'ae-test-01', 'prl-old-other-0001', 'prl-trade-other-0001',
      'taker:test:other', repeat('c',64), 7,
      repeat('d',64), decode('11','hex'),
      'prl-scratch-other-key', repeat('e',64)
    ) AS a;
  IF v_status IS DISTINCT FROM 'CONSUMED'
     OR v_trade IS DISTINCT FROM 'prl-trade-other-0001' THEN
    RAISE EXCEPTION 'nonPRL historical replay regression';
  END IF;

  -- The same idempotency key/hash for a different trade MUST NOT replay.
  BEGIN
    PERFORM asset_exchange.accept_offer_atomic(
      'ae-test-01', 'prl-old-other-0001', 'prl-trade-fake-0001',
      'taker:test:other', repeat('c',64), 7,
      repeat('d',64), decode('11','hex'),
      'prl-scratch-other-key', repeat('e',64)
    );
    RAISE EXCEPTION 'expected mismatched trade refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('idempotency replay offer/trade' IN SQLERRM) = 0 THEN
      RAISE;
    END IF;
  END;

  -- A reused idempotency key with a different request hash remains denied.
  BEGIN
    PERFORM asset_exchange.accept_offer_atomic(
      'ae-test-01', 'prl-old-other-0001', 'prl-trade-other-0001',
      'taker:test:other', repeat('c',64), 7,
      repeat('d',64), decode('11','hex'),
      'prl-scratch-other-key', repeat('1',64)
    );
    RAISE EXCEPTION 'expected request hash mismatch refusal';
  EXCEPTION WHEN SQLSTATE '23505' THEN
    NULL;
  END;

  -- Each persisted field that binds the accepted trade is independently
  -- checked on replay: offer hash, epoch, acceptance hash and signature.
  FOR v_case IN
    SELECT * FROM (VALUES
      ('offer hash', repeat('f',64)::text, 7::bigint,
       repeat('d',64)::text, decode('11','hex')),
      ('policy epoch', repeat('c',64)::text, 8::bigint,
       repeat('d',64)::text, decode('11','hex')),
      ('acceptance hash', repeat('c',64)::text, 7::bigint,
       repeat('1',64)::text, decode('11','hex')),
      ('acceptance signature', repeat('c',64)::text, 7::bigint,
       repeat('d',64)::text, decode('12','hex'))
    ) AS x(label,offer_hash,policy_epoch,acceptance_hash,signature)
  LOOP
    BEGIN
      PERFORM asset_exchange.accept_offer_atomic(
        'ae-test-01', 'prl-old-other-0001', 'prl-trade-other-0001',
        'taker:test:other', v_case.offer_hash, v_case.policy_epoch,
        v_case.acceptance_hash, v_case.signature,
        'prl-scratch-other-key', repeat('e',64)
      );
      RAISE EXCEPTION 'expected % replay mismatch refusal', v_case.label;
    EXCEPTION WHEN SQLSTATE '55000' THEN
      IF position('idempotency replay offer/trade identity mismatch' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
    END;
  END LOOP;

  -- Stored identifiers must be canonical even for non-PRL rows.
  BEGIN
    PERFORM asset_exchange.reject_unqualified_prl_asset_keys(
      'bitcoin|regtest|NATIVE||8',
      'litecoin|regtest|NATIVE|LTC_NATIVE|8'
    );
    RAISE EXCEPTION 'expected malformed asset identity refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('malformed stored asset key' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM asset_exchange.reject_unqualified_prl_asset_keys(
      'bitcoin|regtest|NATIVE|BTC_NATIVE |8',
      'litecoin|regtest|NATIVE|LTC_NATIVE|8'
    );
    RAISE EXCEPTION 'expected non-canonical asset identifier refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('malformed stored asset key' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;

  -- Historical PRL acceptances must not be returned via the old replay path.
  FOR v_case IN
    SELECT * FROM (VALUES
      ('prl-old-give-0001','prl-trade-give-0001','taker:test:prlgive','a',
       'prl-scratch-give-key'),
      ('prl-old-want-0001','prl-trade-want-0001','taker:test:prlwant','b',
       'prl-scratch-want-key')
    ) AS x(offer_id,trade_id,taker_subject,hash_char,idem_key)
  LOOP
    BEGIN
      PERFORM asset_exchange.accept_offer_atomic(
        'ae-test-01', v_case.offer_id, v_case.trade_id,
        v_case.taker_subject, repeat(v_case.hash_char,64), 7,
        repeat('d',64), decode('11','hex'),
        v_case.idem_key, repeat('e',64)
      );
      RAISE EXCEPTION 'expected Pearl historic replay refusal';
    EXCEPTION WHEN SQLSTATE '55000' THEN
      IF position('Pearl' IN SQLERRM) = 0 THEN RAISE; END IF;
    END;
  END LOOP;

  -- Direct SQL trade insertion against a historic OPEN PRL offer.
  BEGIN
    INSERT INTO trades
      (trade_id, deployment_id, offer_id, offer_hash, maker_subject,
       taker_subject, policy_epoch, fee_policy_id, fee_policy_version,
       state, acceptance_hash, acceptance_signature)
    VALUES
      ('prl-forbidden-trade-1', 'ae-test-01', 'prl-old-open-0001',
       repeat('9',64), 'maker:test:prl', 'taker:test:invalid',
       7, 'prl-scratch-policy', 1, 'ACCEPTED_PENDING_TERMS',
       repeat('d',64), decode('11','hex'));
    RAISE EXCEPTION 'expected trade INSERT trigger refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('Pearl' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;

  -- Direct UPDATE to consumed state, bypassing acceptance, must fail.
  BEGIN
    UPDATE offers SET state = 'CONSUMED'
    WHERE offer_id = 'prl-old-open-0001';
    RAISE EXCEPTION 'expected consumption trigger refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('Pearl' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;

  -- Direct SQL offer publication must fail before a new PRL row exists.
  BEGIN
    INSERT INTO offers (
      offer_id, deployment_id, maker_subject, offer_hash, signed_offer,
      signature, signature_scheme, give_asset_key, give_amount_atomic,
      want_asset_key, want_amount_atomic, nonce, policy_epoch,
      fee_policy_id, fee_policy_version, expires_at, state
    ) VALUES (
      'prl-forbidden-offer-1', 'ae-test-01', 'maker:test:prl',
      repeat('8',64), decode('00','hex'), decode('01','hex'),
      'NOT_A_SIGNATURE', 'pearl|mainnet|NATIVE|PRL_UNVERIFIED|8', 100,
      'bitcoin|regtest|NATIVE|BTC_NATIVE|8', 250,
      'ABCDEFGHIJKLMNOP', 7, 'prl-scratch-policy', 1,
      clock_timestamp() + interval '1 day', 'OPEN'
    );
    RAISE EXCEPTION 'expected PRL offer INSERT trigger refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('Pearl' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;

  -- Even with the acceptance switch enabled in THIS ROLLED-BACK TEST
  -- transaction, a fresh acceptance of a historic OPEN PRL offer fails.
  UPDATE operator_state SET new_accepts_enabled = TRUE WHERE singleton = TRUE;
  BEGIN
    PERFORM asset_exchange.accept_offer_atomic(
      'ae-test-01','prl-old-open-0001','prl-forbidden-accept-1',
      'taker:test:newprl',repeat('9',64),7,repeat('d',64),
      decode('11','hex'),'prl-forbidden-accept-key',repeat('e',64)
    );
    RAISE EXCEPTION 'expected new historic PRL acceptance refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('Pearl' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;

  IF (SELECT state FROM offers WHERE offer_id='prl-old-open-0001') <> 'OPEN'
     OR (SELECT count(*) FROM trades WHERE offer_id='prl-old-open-0001') <> 0
     OR (SELECT count(*) FROM idempotency_records) <> 3 THEN
    RAISE EXCEPTION 'scratch database was unexpectedly mutated';
  END IF;
END;
$tests$;

-- No validation data is committed by this script.
ROLLBACK;
