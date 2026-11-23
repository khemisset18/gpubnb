-- GPUbnb Asset Exchange / Pearl PRL idempotent replay quarantine
-- ADDITIVE FUNCTION REPLACEMENT; NOT TESTED ON POSTGRES, NOT DEPLOYED.
-- Requires migrations 001-010 in a strictly isolated disposable Exchange DB.
-- Preserves public SQL signature and the non-PRL acceptance flow.
BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;

CREATE OR REPLACE FUNCTION accept_offer_atomic(
  p_deployment_id text,
  p_offer_id text,
  p_trade_id text,
  p_taker_subject text,
  p_offer_hash char(64),
  p_policy_epoch bigint,
  p_acceptance_hash char(64),
  p_acceptance_signature bytea,
  p_idempotency_key text,
  p_request_hash char(64)
)
RETURNS TABLE(status text, trade_id text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $$
DECLARE
  v_offer asset_exchange.offers%ROWTYPE;
  v_operator asset_exchange.operator_state%ROWTYPE;
  v_existing asset_exchange.idempotency_records%ROWTYPE;
  v_scope text := 'accept_offer:' || p_deployment_id || ':' || p_taker_subject;
BEGIN
  IF p_acceptance_signature IS NULL OR octet_length(p_acceptance_signature) = 0 THEN
    RAISE EXCEPTION 'acceptance signature required' USING ERRCODE = '22023';
  END IF;

  IF p_request_hash IS NULL
     OR p_request_hash::text !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'valid request hash required' USING ERRCODE = '22023';
  END IF;

  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023';
  END IF;

  -- Serialize the same idempotency scope/key across database sessions before
  -- checking for an existing record. Without this transaction-scoped lock,
  -- simultaneous first requests could both miss the record and the loser
  -- would see an unrelated uniqueness or consumed-offer error.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_scope),
    pg_catalog.hashtext(p_idempotency_key)
  );

  SELECT * INTO v_existing
  FROM asset_exchange.idempotency_records
  WHERE scope = v_scope AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'idempotency key reused with different request'
        USING ERRCODE = '23505';
    END IF;
    -- A replay must not bypass the current asset quarantine or return
    -- an unrelated historical trade. Validate the actual stored offer and
    -- trade before returning the idempotency result.
    SELECT o.* INTO v_offer
    FROM asset_exchange.offers AS o
    JOIN asset_exchange.trades AS t
      ON t.offer_id = o.offer_id
     AND t.deployment_id = o.deployment_id
    WHERE o.offer_id = p_offer_id
      AND o.deployment_id = p_deployment_id
      AND o.offer_hash = p_offer_hash
      AND o.policy_epoch = p_policy_epoch
      AND o.state = 'CONSUMED'
      AND o.accepted_trade_id = p_trade_id
      AND t.trade_id = p_trade_id
      AND t.taker_subject = p_taker_subject
      AND t.offer_hash = p_offer_hash
      AND t.policy_epoch = p_policy_epoch
      AND t.acceptance_hash = p_acceptance_hash
      AND t.acceptance_signature = p_acceptance_signature
      AND v_existing.result_ref = p_trade_id
    FOR UPDATE OF o;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'idempotency replay offer/trade identity mismatch'
        USING ERRCODE = '55000';
    END IF;

    PERFORM asset_exchange.reject_unqualified_prl_asset_keys(
      v_offer.give_asset_key, v_offer.want_asset_key
    );

    RETURN QUERY SELECT 'CONSUMED'::text, v_existing.result_ref::text;
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
     OR v_operator.new_accepts_enabled IS NOT TRUE
     OR v_operator.policy_epoch <> p_policy_epoch THEN
    RAISE EXCEPTION 'acceptance blocked by current policy epoch/state'
      USING ERRCODE = '55000';
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

  -- A brand-new acceptance remains blocked even for direct SQL callers,
  -- before any trades are inserted. Migration 010 adds independent triggers.
  PERFORM asset_exchange.reject_unqualified_prl_asset_keys(
    v_offer.give_asset_key, v_offer.want_asset_key
  );

  IF v_offer.state <> 'OPEN' THEN
    RAISE EXCEPTION 'offer is not open' USING ERRCODE = '55000';
  END IF;

  IF v_offer.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'offer expired' USING ERRCODE = '55000';
  END IF;

  IF v_offer.offer_hash <> p_offer_hash THEN
    RAISE EXCEPTION 'offer hash mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_offer.policy_epoch <> p_policy_epoch THEN
    RAISE EXCEPTION 'offer epoch mismatch' USING ERRCODE = '55000';
  END IF;

  INSERT INTO asset_exchange.trades (
    trade_id,
    deployment_id,
    offer_id,
    offer_hash,
    maker_subject,
    taker_subject,
    policy_epoch,
    fee_policy_id,
    fee_policy_version,
    state,
    acceptance_hash,
    acceptance_signature
  ) VALUES (
    p_trade_id,
    p_deployment_id,
    p_offer_id,
    p_offer_hash,
    v_offer.maker_subject,
    p_taker_subject,
    p_policy_epoch,
    v_offer.fee_policy_id,
    v_offer.fee_policy_version,
    'ACCEPTED_PENDING_TERMS',
    p_acceptance_hash,
    p_acceptance_signature
  );

  UPDATE asset_exchange.offers
  SET state = 'CONSUMED',
      accepted_trade_id = p_trade_id,
      consumed_at = clock_timestamp()
  WHERE offer_id = p_offer_id
    AND state = 'OPEN';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer lost acceptance race' USING ERRCODE = '40001';
  END IF;

  INSERT INTO asset_exchange.trade_events (
    event_id,
    trade_id,
    sequence_no,
    event_type,
    previous_state,
    new_state,
    policy_epoch,
    idempotency_key,
    evidence,
    config_hash
  ) VALUES (
    'accept:' || p_trade_id,
    p_trade_id,
    1,
    'OFFER_ACCEPTED',
    NULL,
    'ACCEPTED_PENDING_TERMS',
    p_policy_epoch,
    p_idempotency_key,
    jsonb_build_object(
      'offer_id', p_offer_id,
      'offer_hash', p_offer_hash,
      'acceptance_hash', p_acceptance_hash,
      'deployment_id', p_deployment_id
    ),
    v_operator.config_hash
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
    p_trade_id
  );

  RETURN QUERY SELECT 'CONSUMED'::text, p_trade_id::text;
END;
$$;

COMMIT;
