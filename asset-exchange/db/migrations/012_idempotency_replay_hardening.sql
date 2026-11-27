-- GPUbnb Asset Exchange
-- Durable, identity-bound replay handling for publication, cancellation and
-- settlement-term signatures. Additive function replacement; NOT DEPLOYED.
-- Requires 001-011. Run only in an isolated disposable Exchange PostgreSQL DB.
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
  v_offer asset_exchange.offers%ROWTYPE;
  v_existing asset_exchange.idempotency_records%ROWTYPE;
  v_scope text;
BEGIN
  IF p_deployment_id IS NULL OR p_deployment_id !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
     OR p_offer_id IS NULL OR length(p_offer_id) NOT BETWEEN 8 AND 128
     OR p_maker_subject IS NULL OR length(p_maker_subject) NOT BETWEEN 3 AND 256
     OR p_maker_subject <> btrim(p_maker_subject)
     OR p_offer_hash IS NULL OR p_offer_hash::text !~ '^[0-9a-f]{64}$'
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     OR p_request_hash IS NULL OR p_request_hash::text !~ '^[0-9a-f]{64}$'
     OR p_policy_epoch IS NULL OR p_policy_epoch < 0
     OR p_fee_policy_version IS NULL OR p_fee_policy_version < 1
     OR p_expires_at IS NULL
     OR p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{16,128}$'
     OR p_signature_scheme IS NULL OR length(p_signature_scheme) NOT BETWEEN 1 AND 64
     OR p_fee_policy_id IS NULL OR length(p_fee_policy_id) NOT BETWEEN 1 AND 128
     OR p_give_asset_key IS NULL OR p_want_asset_key IS NULL THEN
    RAISE EXCEPTION 'invalid publication identity or idempotency input'
      USING ERRCODE = '22023';
  END IF;
  IF p_signature IS NULL OR octet_length(p_signature) NOT BETWEEN 1 AND 8192
     OR p_signed_offer IS NULL OR octet_length(p_signed_offer) NOT BETWEEN 1 AND 65536
     OR p_give_amount IS NULL OR p_give_amount <= 0
     OR p_want_amount IS NULL OR p_want_amount <= 0 THEN
    RAISE EXCEPTION 'invalid signed offer evidence or amount'
      USING ERRCODE = '22023';
  END IF;

  v_scope := 'publish_offer:' || p_deployment_id || ':' || p_maker_subject;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_scope), pg_catalog.hashtext(p_idempotency_key)
  );

  SELECT * INTO v_existing
  FROM asset_exchange.idempotency_records
  WHERE scope = v_scope AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'idempotency key reused with different request'
        USING ERRCODE = '23505';
    END IF;
    SELECT o.* INTO v_offer
    FROM asset_exchange.offers AS o
    WHERE o.offer_id = p_offer_id
      AND o.deployment_id = p_deployment_id
      AND o.maker_subject = p_maker_subject
      AND o.offer_hash = p_offer_hash
      AND o.signed_offer = p_signed_offer
      AND o.signature = p_signature
      AND o.signature_scheme = p_signature_scheme
      AND o.give_asset_key = p_give_asset_key
      AND o.give_amount_atomic = p_give_amount
      AND o.want_asset_key = p_want_asset_key
      AND o.want_amount_atomic = p_want_amount
      AND o.nonce = p_nonce
      AND o.policy_epoch = p_policy_epoch
      AND o.fee_policy_id = p_fee_policy_id
      AND o.fee_policy_version = p_fee_policy_version
      AND o.expires_at = p_expires_at
      AND v_existing.result_ref = p_offer_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'idempotency replay publication identity mismatch'
        USING ERRCODE = '55000';
    END IF;
    PERFORM asset_exchange.reject_unqualified_prl_asset_keys(
      v_offer.give_asset_key, v_offer.want_asset_key
    );
    RETURN QUERY SELECT 'OPEN'::text, v_existing.result_ref::text;
    RETURN;
  END IF;

  -- Expiry is checked after the replay branch: a retry can return the exact
  -- durable publication result after expiration, while a fresh write cannot.
  PERFORM asset_exchange.reject_unqualified_prl_asset_keys(
    p_give_asset_key, p_want_asset_key
  );

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

  IF p_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'cannot publish expired offer' USING ERRCODE = '55000';
  END IF;

  INSERT INTO asset_exchange.offers (
    offer_id, deployment_id, maker_subject, offer_hash, signed_offer,
    signature, signature_scheme, give_asset_key, give_amount_atomic,
    want_asset_key, want_amount_atomic, nonce, policy_epoch,
    fee_policy_id, fee_policy_version, expires_at, state
  ) VALUES (
    p_offer_id, p_deployment_id, p_maker_subject, p_offer_hash, p_signed_offer,
    p_signature, p_signature_scheme, p_give_asset_key, p_give_amount,
    p_want_asset_key, p_want_amount, p_nonce, p_policy_epoch,
    p_fee_policy_id, p_fee_policy_version, p_expires_at, 'OPEN'
  );
  INSERT INTO asset_exchange.idempotency_records
    (scope, idempotency_key, request_hash, result_ref)
  VALUES (v_scope, p_idempotency_key, p_request_hash, p_offer_id);
  RETURN QUERY SELECT 'OPEN'::text, p_offer_id::text;
END;
$$;

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
  v_scope text;
BEGIN
  IF p_deployment_id IS NULL OR p_deployment_id !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
     OR p_offer_id IS NULL OR length(p_offer_id) NOT BETWEEN 8 AND 128
     OR p_maker_subject IS NULL OR length(p_maker_subject) NOT BETWEEN 3 AND 256
     OR p_maker_subject <> btrim(p_maker_subject)
     OR p_cancellation_hash IS NULL OR p_cancellation_hash::text !~ '^[0-9a-f]{64}$'
     OR p_cancellation_signature IS NULL
     OR octet_length(p_cancellation_signature) NOT BETWEEN 1 AND 8192
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     OR p_request_hash IS NULL OR p_request_hash::text !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid cancellation identity or idempotency input'
      USING ERRCODE = '22023';
  END IF;
  v_scope := 'cancel_offer:' || p_deployment_id || ':' || p_maker_subject;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_scope), pg_catalog.hashtext(p_idempotency_key)
  );

  SELECT * INTO v_existing
  FROM asset_exchange.idempotency_records
  WHERE scope = v_scope AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'idempotency key reused with different request'
        USING ERRCODE = '23505';
    END IF;
    SELECT o.* INTO v_offer
    FROM asset_exchange.offers AS o
    WHERE o.offer_id = p_offer_id
      AND o.deployment_id = p_deployment_id
      AND o.maker_subject = p_maker_subject
      AND o.state = 'CANCELLED'
      AND o.cancellation_hash = p_cancellation_hash
      AND o.cancellation_signature = p_cancellation_signature
      AND v_existing.result_ref = p_offer_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'idempotency replay cancellation identity mismatch'
        USING ERRCODE = '55000';
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
  SET state = 'CANCELLED', cancelled_at = clock_timestamp(),
      cancellation_hash = p_cancellation_hash,
      cancellation_signature = p_cancellation_signature
  WHERE o.offer_id = p_offer_id AND o.state = 'OPEN';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer lost cancellation race' USING ERRCODE = '40001';
  END IF;
  INSERT INTO asset_exchange.idempotency_records
    (scope, idempotency_key, request_hash, result_ref)
  VALUES (v_scope, p_idempotency_key, p_request_hash, p_offer_id);
  RETURN QUERY SELECT 'CANCELLED'::text, p_offer_id::text;
END;
$$;

CREATE OR REPLACE FUNCTION submit_trade_terms_signature_atomic(
  p_deployment_id text,
  p_trade_id text,
  p_actor_subject text,
  p_role text,
  p_terms_hash char(64),
  p_signature bytea,
  p_idempotency_key text,
  p_request_hash char(64)
)
RETURNS TABLE(status text, trade_id text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $$
DECLARE
  v_trade asset_exchange.trades%ROWTYPE;
  v_operator asset_exchange.operator_state%ROWTYPE;
  v_existing asset_exchange.idempotency_records%ROWTYPE;
  v_scope text;
  v_replay boolean;
  v_sequence bigint;
  v_event_type text;
  v_previous_state text;
BEGIN
  IF p_deployment_id IS NULL OR p_deployment_id !~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
     OR p_trade_id IS NULL OR length(p_trade_id) NOT BETWEEN 8 AND 128
     OR p_actor_subject IS NULL OR length(p_actor_subject) NOT BETWEEN 3 AND 256
     OR p_actor_subject <> btrim(p_actor_subject)
     OR p_role IS NULL OR p_role NOT IN ('MAKER','TAKER')
     OR p_terms_hash IS NULL OR p_terms_hash::text !~ '^[0-9a-f]{64}$'
     OR p_signature IS NULL OR octet_length(p_signature) NOT BETWEEN 1 AND 8192
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     OR p_request_hash IS NULL OR p_request_hash::text !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid terms identity or idempotency input'
      USING ERRCODE = '22023';
  END IF;
  v_scope := 'trade_terms:' || p_deployment_id || ':' || p_trade_id || ':'
    || p_role || ':' || p_actor_subject;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_scope), pg_catalog.hashtext(p_idempotency_key)
  );

  SELECT * INTO v_existing
  FROM asset_exchange.idempotency_records
  WHERE scope = v_scope AND idempotency_key = p_idempotency_key;
  v_replay := FOUND;
  IF v_replay AND v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'idempotency key reused with different request'
      USING ERRCODE = '23505';
  END IF;

  SELECT t.* INTO v_trade
  FROM asset_exchange.trades AS t
  WHERE t.trade_id = p_trade_id AND t.deployment_id = p_deployment_id
  FOR UPDATE;
  IF NOT FOUND THEN
    IF v_replay THEN
      RAISE EXCEPTION 'idempotency replay terms identity mismatch' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT FROM asset_exchange.trades AS t WHERE t.trade_id = p_trade_id) THEN
      RAISE EXCEPTION 'deployment mismatch' USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION 'trade not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM asset_exchange.reject_unqualified_prl_asset_keys(o.give_asset_key, o.want_asset_key)
  FROM asset_exchange.offers AS o
  WHERE o.offer_id = v_trade.offer_id AND o.deployment_id = v_trade.deployment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement offer identity unavailable' USING ERRCODE = '55000';
  END IF;
  IF v_replay THEN
    IF v_existing.result_ref IS DISTINCT FROM p_trade_id
       OR (p_role = 'MAKER' AND v_trade.maker_subject IS DISTINCT FROM p_actor_subject)
       OR (p_role = 'TAKER' AND v_trade.taker_subject IS DISTINCT FROM p_actor_subject)
       OR v_trade.terms_hash IS DISTINCT FROM p_terms_hash
       OR (p_role = 'MAKER' AND v_trade.signed_terms_a IS DISTINCT FROM p_signature)
       OR (p_role = 'TAKER' AND v_trade.signed_terms_b IS DISTINCT FROM p_signature) THEN
      RAISE EXCEPTION 'idempotency replay terms identity mismatch'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT v_trade.state::text, v_trade.trade_id::text;
    RETURN;
  END IF;

  IF v_trade.state NOT IN ('ACCEPTED_PENDING_TERMS','TERMS_SIGNED') THEN
    RAISE EXCEPTION 'trade is not accepting settlement terms signatures'
      USING ERRCODE = '55000';
  END IF;
  IF p_role = 'MAKER' AND v_trade.maker_subject <> p_actor_subject THEN
    RAISE EXCEPTION 'maker authorization mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_role = 'TAKER' AND v_trade.taker_subject <> p_actor_subject THEN
    RAISE EXCEPTION 'taker authorization mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_trade.terms_hash IS NOT NULL AND v_trade.terms_hash <> p_terms_hash THEN
    RAISE EXCEPTION 'settlement terms hash mismatch' USING ERRCODE = '22023';
  END IF;

  IF p_role = 'MAKER' AND v_trade.signed_terms_a IS NOT NULL THEN
    IF v_trade.terms_hash IS DISTINCT FROM p_terms_hash
       OR v_trade.signed_terms_a IS DISTINCT FROM p_signature THEN
      RAISE EXCEPTION 'maker settlement terms signature is write-once'
        USING ERRCODE = '55000';
    END IF;
  ELSIF p_role = 'TAKER' AND v_trade.signed_terms_b IS NOT NULL THEN
    IF v_trade.terms_hash IS DISTINCT FROM p_terms_hash
       OR v_trade.signed_terms_b IS DISTINCT FROM p_signature THEN
      RAISE EXCEPTION 'taker settlement terms signature is write-once'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    v_previous_state := v_trade.state;
    UPDATE asset_exchange.trades
    SET terms_hash = COALESCE(terms_hash, p_terms_hash),
        signed_terms_a = CASE WHEN p_role = 'MAKER' THEN p_signature ELSE signed_terms_a END,
        signed_terms_b = CASE WHEN p_role = 'TAKER' THEN p_signature ELSE signed_terms_b END,
        updated_at = clock_timestamp()
    WHERE trades.trade_id = p_trade_id;
    SELECT t.* INTO v_trade FROM asset_exchange.trades AS t
    WHERE t.trade_id = p_trade_id;
    IF v_trade.signed_terms_a IS NOT NULL AND v_trade.signed_terms_b IS NOT NULL THEN
      UPDATE asset_exchange.trades
      SET state = 'TERMS_SIGNED', updated_at = clock_timestamp()
      WHERE trades.trade_id = p_trade_id;
      v_trade.state := 'TERMS_SIGNED';
    END IF;
    SELECT * INTO v_operator FROM asset_exchange.operator_state WHERE singleton = TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'operator state missing' USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(MAX(sequence_no), 0) + 1 INTO v_sequence
    FROM asset_exchange.trade_events WHERE trade_events.trade_id = p_trade_id;
    v_event_type := CASE WHEN p_role = 'MAKER'
      THEN 'TERMS_SIGNATURE_MAKER' ELSE 'TERMS_SIGNATURE_TAKER' END;
    INSERT INTO asset_exchange.trade_events (
      event_id, trade_id, sequence_no, event_type, previous_state, new_state,
      policy_epoch, idempotency_key, evidence, config_hash
    ) VALUES (
      'terms:' || p_trade_id || ':' || lower(p_role) || ':' || v_sequence::text,
      p_trade_id, v_sequence, v_event_type, v_previous_state, v_trade.state,
      v_trade.policy_epoch, p_idempotency_key,
      jsonb_build_object('terms_hash', p_terms_hash, 'role', p_role,
        'deployment_id', p_deployment_id), v_operator.config_hash
    );
  END IF;

  INSERT INTO asset_exchange.idempotency_records
    (scope, idempotency_key, request_hash, result_ref)
  VALUES (v_scope, p_idempotency_key, p_request_hash, p_trade_id);
  SELECT t.* INTO v_trade FROM asset_exchange.trades AS t
  WHERE t.trade_id = p_trade_id;
  RETURN QUERY SELECT v_trade.state::text, v_trade.trade_id::text;
END;
$$;

COMMIT;
