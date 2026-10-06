-- gpu.k.p2p Asset Exchange
-- G5 atomic offer publication function.
-- NO REAL FUNDS / NO MAINNET.

BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;

CREATE OR REPLACE FUNCTION publish_offer_atomic(
  p_deployment_id text,
  p_offer_id text,
  p_maker_subject text,
  p_offer_hash char(64),
  p_signed_offer bytea,
  p_signature bytea,
  p_signature_scheme text,
  p_give_asset_key text,
  p_give_amount atomic_u128,
  p_want_asset_key text,
  p_want_amount atomic_u128,
  p_nonce text,
  p_policy_epoch bigint,
  p_fee_policy_id text,
  p_fee_policy_version bigint,
  p_expires_at timestamptz,
  p_idempotency_key text,
  p_request_hash char(64)
)
RETURNS TABLE(status text, offer_id text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $$
DECLARE
  v_operator asset_exchange.operator_state%ROWTYPE;
  v_existing asset_exchange.idempotency_records%ROWTYPE;
  v_scope text := 'publish_offer:' || p_deployment_id || ':' || p_maker_subject;
BEGIN
  IF p_signature IS NULL OR octet_length(p_signature) = 0 THEN
    RAISE EXCEPTION 'offer signature required' USING ERRCODE = '22023';
  END IF;

  IF p_signed_offer IS NULL OR octet_length(p_signed_offer) = 0 THEN
    RAISE EXCEPTION 'signed offer payload required' USING ERRCODE = '22023';
  END IF;

  IF p_give_amount <= 0 OR p_want_amount <= 0 THEN
    RAISE EXCEPTION 'offer amounts must be positive' USING ERRCODE = '22023';
  END IF;

  IF p_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'cannot publish expired offer' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_existing
  FROM asset_exchange.idempotency_records
  WHERE scope = v_scope
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'idempotency key reused with different request'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 'OPEN'::text, v_existing.result_ref::text;
    RETURN;
  END IF;

  SELECT * INTO v_operator
  FROM asset_exchange.operator_state
  WHERE singleton = TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator state missing' USING ERRCODE = '55000';
  END IF;

  IF v_operator.mode = 'TRANSITION'
     OR v_operator.new_offers_enabled IS NOT TRUE
     OR v_operator.policy_epoch <> p_policy_epoch THEN
    RAISE EXCEPTION 'offer publication blocked by current policy epoch/state'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO asset_exchange.offers (
    offer_id,
    deployment_id,
    maker_subject,
    offer_hash,
    signed_offer,
    signature,
    signature_scheme,
    give_asset_key,
    give_amount_atomic,
    want_asset_key,
    want_amount_atomic,
    nonce,
    policy_epoch,
    fee_policy_id,
    fee_policy_version,
    expires_at,
    state
  ) VALUES (
    p_offer_id,
    p_deployment_id,
    p_maker_subject,
    p_offer_hash,
    p_signed_offer,
    p_signature,
    p_signature_scheme,
    p_give_asset_key,
    p_give_amount,
    p_want_asset_key,
    p_want_amount,
    p_nonce,
    p_policy_epoch,
    p_fee_policy_id,
    p_fee_policy_version,
    p_expires_at,
    'OPEN'
  );

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

  RETURN QUERY SELECT 'OPEN'::text, p_offer_id::text;
END;
$$;

COMMIT;
