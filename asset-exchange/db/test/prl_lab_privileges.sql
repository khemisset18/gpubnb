BEGIN;
DO $$
BEGIN
  IF current_database() !~ '^prl_scratch_[a-z0-9_]+$' OR current_user <> 'prl_lab_owner' THEN
    RAISE EXCEPTION 'unexpected database or schema owner';
  END IF;
  IF EXISTS (SELECT FROM pg_proc WHERE pronamespace='asset_exchange'::regnamespace AND prosecdef)
     OR has_schema_privilege('prl_lab_reader','asset_exchange','CREATE') THEN
    RAISE EXCEPTION 'privileges exceed laboratory boundary';
  END IF;
END;
$$;
-- Exercise DML privileges using an actual non-owner role. All grants roll back.
GRANT USAGE ON SCHEMA asset_exchange TO prl_lab_reader;
GRANT SELECT ON asset_exchange.offers TO prl_lab_reader;
SET LOCAL ROLE prl_lab_reader;
SELECT count(*) AS reader_visible_offers FROM asset_exchange.offers;
DO $$
BEGIN
  BEGIN
    UPDATE asset_exchange.offers SET state='OPEN' WHERE false;
    RAISE EXCEPTION 'expected table write refusal';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM asset_exchange.cancel_offer_atomic('ae-test-01','prl-old-open-0001',
      'maker:test:prl',repeat('a',64),decode('aa','hex'),'readonly-role-key',repeat('c',64));
    RAISE EXCEPTION 'expected invoker privilege refusal';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
ROLLBACK;
