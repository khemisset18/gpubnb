-- gpu.k.p2p Asset Exchange
-- Signed offer cancellation evidence.
-- NO REAL FUNDS / NO MAINNET.

BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;

ALTER TABLE offers
  ADD COLUMN cancellation_hash char(64)
    CHECK (cancellation_hash IS NULL OR cancellation_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN cancellation_signature bytea;

ALTER TABLE offers
  ADD CONSTRAINT offers_cancellation_evidence_check
  CHECK (
    (
      state = 'CANCELLED'
      AND cancelled_at IS NOT NULL
      AND cancellation_hash IS NOT NULL
      AND cancellation_signature IS NOT NULL
      AND octet_length(cancellation_signature) > 0
    )
    OR
    (
      state <> 'CANCELLED'
      AND cancellation_hash IS NULL
      AND cancellation_signature IS NULL
    )
  ) NOT VALID;

ALTER TABLE offers
  VALIDATE CONSTRAINT offers_cancellation_evidence_check;

DROP FUNCTION IF EXISTS asset_exchange.cancel_offer_atomic(
  text,text,text,text,char(64)
);

CREATE OR REPLACE FUNCTION cancel_offer_atomic(
  p_deployment_id text,
  p_offer_id text,
  p_maker_subject text,
  p_cancellation_hash char(64),
  p_cancellation_signature bytea,
  p_idempotency_key text,
  p_request_hash char(64)
)
RETURNS TABLE(status text, offer_id text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $$
DECLARE
  v_offer asset_exchange.offers%ROWTYPE;
  v_existing asset_exchange.idempotency_records%ROWTYPE;
  v_scope text := 'cancel_offer:' || p_deployment_id || ':' || p_maker_subject;
BEGIN
  IF p_cancellation_hash IS NULL
     OR p_cancellation_hash !~ '^[0-9a-f]{64}$'
     OR p_cancellation_signature IS NULL
     OR octet_length(p_cancellation_signature) = 0 THEN
    RAISE EXCEPTION 'signed cancellation evidence required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
  FROM asset_exchange.idempotency_records
  WHERE scope = v_scope AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'idempotency key reused with different request'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 'CANCELLED'::text, v_existing.result_ref::text;
    RETURN;
  END IF;

  SELECT o.* INTO v_offer
  FROM asset_exchange.offers AS o
  WHERE o.offer_id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_offer.deployment_id <> p_deployment_id THEN
    RAISE EXCEPTION 'deployment mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_offer.maker_subject <> p_maker_subject THEN
    RAISE EXCEPTION 'maker authorization mismatch' USING ERRCODE = '42501';
  END IF;

  IF v_offer.state <> 'OPEN' THEN
    RAISE EXCEPTION 'offer is not open' USING ERRCODE = '55000';
  END IF;

  UPDATE asset_exchange.offers AS o
  SET state = 'CANCELLED',
      cancelled_at = clock_timestamp(),
      cancellation_hash = p_cancellation_hash,
      cancellation_signature = p_cancellation_signature
  WHERE o.offer_id = p_offer_id
    AND o.state = 'OPEN';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer lost cancellation race' USING ERRCODE = '40001';
  END IF;

  INSERT INTO asset_exchange.idempotency_records (
    scope,
    idempotency_key,
    request_hash,
    result_ref
  ) VALUES (
    v_scope,
    p_idempotency_key,
    p_request_hash,
    p_offer_id
  );

  RETURN QUERY SELECT 'CANCELLED'::text, p_offer_id::text;
END;
$$;

COMMIT;
