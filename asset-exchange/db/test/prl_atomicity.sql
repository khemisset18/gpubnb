-- Run only in the disposable campaign after the historical fixtures and 012.
BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;
DO $$
BEGIN
  IF current_database() !~ '^prl_scratch_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'expected fresh Pearl scratch database';
  END IF;
END;
$$;
-- Inject an ordinary constraint failure at the final write. All earlier effects
-- in the same acceptance must be rolled back by PostgreSQL.
ALTER TABLE idempotency_records ADD CHECK (idempotency_key <> 'lab-rollback-accept');
UPDATE operator_state SET new_offers_enabled = true, new_accepts_enabled = true WHERE singleton;
SELECT * FROM publish_offer_atomic(
  'ae-test-01','atomic-offer-001','maker:scratch',repeat('6',64),
  decode('aa','hex'),decode('bb','hex'),'TEST_ONLY',
  'bitcoin|regtest|NATIVE|BTC_NATIVE|8',100, 'litecoin|regtest|NATIVE|LTC_NATIVE|8',250,
  'ABCDEFGHIJKLMNOP',7,'prl-scratch-policy',1,clock_timestamp()+interval '1 hour',
  'lab-rollback-publish',repeat('1',64));
DO $$
BEGIN
  BEGIN
    PERFORM submit_trade_terms_signature_atomic('ae-test-01','prl-trade-give-0001',
      'maker:test:prl','MAKER',repeat('6',64),decode('aa','hex'),
      'historical-terms-lab',repeat('8',64));
    RAISE EXCEPTION 'expected historical PRL terms refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('Pearl' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM submit_trade_terms_signature_atomic('ae-test-01','prl-trade-want-0001',
      'maker:test:prl','MAKER',repeat('6',64),decode('aa','hex'),
      'legacy-prl-terms-01',repeat('8',64));
    RAISE EXCEPTION 'expected fully matching historic PRL terms replay refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('Pearl' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM reject_unqualified_prl_asset_keys('test|scratch|NATIVE|' || chr(160) || 'ID|8',
      'test|scratch|NATIVE|CANONICAL|8');
    RAISE EXCEPTION 'expected noncanonical asset identifier refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('malformed stored asset key' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE trades SET signed_terms_b=decode('bb','hex'), state='TERMS_SIGNED'
    WHERE trade_id='prl-trade-want-0001';
    RAISE EXCEPTION 'expected direct historical terms refusal';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('Pearl' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT FROM trade_events WHERE idempotency_key='historical-terms-lab')
     OR (SELECT signed_terms_a FROM trades WHERE trade_id='prl-trade-give-0001') IS NOT NULL THEN
    RAISE EXCEPTION 'historical trade changed';
  END IF;
  BEGIN
    PERFORM accept_offer_atomic('ae-test-01','atomic-offer-001','atomic-trade-001',
      'taker:scratch',repeat('6',64),7,NULL,decode('aa','hex'),
      'lab-null-evidence',repeat('8',64));
    RAISE EXCEPTION 'expected missing acceptance evidence refusal';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM accept_offer_atomic('ae-test-01','atomic-offer-001','atomic-trade-001',
      'taker:scratch',repeat('6',64),7,repeat('7',64),decode('aa','hex'),
      'lab-rollback-accept',repeat('8',64));
    RAISE EXCEPTION 'expected failure of final write';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%idempotency_records%' THEN RAISE; END IF;
  END;
  IF (SELECT state FROM offers WHERE offer_id='atomic-offer-001') IS DISTINCT FROM 'OPEN'
     OR EXISTS (SELECT FROM trades WHERE trade_id='atomic-trade-001')
     OR EXISTS (SELECT FROM trade_events WHERE trade_id='atomic-trade-001')
     OR EXISTS (SELECT FROM idempotency_records WHERE idempotency_key='lab-rollback-accept') THEN
    RAISE EXCEPTION 'partial acceptance after failed final write';
  END IF;
END;
$$;
ROLLBACK;
