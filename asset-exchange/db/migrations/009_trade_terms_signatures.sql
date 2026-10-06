-- gpu.k.p2p Asset Exchange
-- Two-party final settlement terms signature gate.
-- NO REAL FUNDS / NO MAINNET.

BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;

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
  v_scope text :=
    'trade_terms:' || p_deployment_id || ':' || p_trade_id || ':' || p_role || ':' || p_actor_subject;
  v_sequence bigint;
  v_event_type text;
  v_previous_state text;
BEGIN
  IF p_role NOT IN ('MAKER','TAKER') THEN
    RAISE EXCEPTION 'invalid settlement terms signer role' USING ERRCODE = '22023';
  END IF;
  IF p_terms_hash IS NULL OR p_terms_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'valid terms hash required' USING ERRCODE = '22023';
  END IF;
  IF p_signature IS NULL OR octet_length(p_signature) = 0 THEN
    RAISE EXCEPTION 'settlement terms signature required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
  FROM asset_exchange.idempotency_records
  WHERE scope = v_scope AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'idempotency key reused with different request'
        USING ERRCODE = '23505';
    END IF;
    SELECT t.* INTO v_trade
    FROM asset_exchange.trades AS t
    WHERE t.trade_id = p_trade_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'trade not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN QUERY SELECT v_trade.state::text, v_trade.trade_id::text;
    RETURN;
  END IF;

  SELECT t.* INTO v_trade
  FROM asset_exchange.trades AS t
  WHERE t.trade_id = p_trade_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'trade not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_trade.deployment_id <> p_deployment_id THEN
    RAISE EXCEPTION 'deployment mismatch' USING ERRCODE = '22023';
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
    IF v_trade.signed_terms_a <> p_signature THEN
      RAISE EXCEPTION 'maker settlement terms signature is write-once'
        USING ERRCODE = '55000';
    END IF;
  ELSIF p_role = 'TAKER' AND v_trade.signed_terms_b IS NOT NULL THEN
    IF v_trade.signed_terms_b <> p_signature THEN
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

    SELECT t.* INTO v_trade
    FROM asset_exchange.trades AS t
    WHERE t.trade_id = p_trade_id;

    IF v_trade.signed_terms_a IS NOT NULL
       AND v_trade.signed_terms_b IS NOT NULL THEN
      UPDATE asset_exchange.trades
      SET state = 'TERMS_SIGNED',
          updated_at = clock_timestamp()
      WHERE trades.trade_id = p_trade_id;
      v_trade.state := 'TERMS_SIGNED';
    END IF;

    SELECT * INTO v_operator
    FROM asset_exchange.operator_state
    WHERE singleton = TRUE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'operator state missing' USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(MAX(sequence_no), 0) + 1
    INTO v_sequence
    FROM asset_exchange.trade_events
    WHERE trade_events.trade_id = p_trade_id;

    v_event_type := CASE
      WHEN p_role = 'MAKER' THEN 'TERMS_SIGNATURE_MAKER'
      ELSE 'TERMS_SIGNATURE_TAKER'
    END;

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
      'terms:' || p_trade_id || ':' || lower(p_role) || ':' || v_sequence::text,
      p_trade_id,
      v_sequence,
      v_event_type,
      v_previous_state,
      v_trade.state,
      v_trade.policy_epoch,
      p_idempotency_key,
      jsonb_build_object(
        'terms_hash', p_terms_hash,
        'role', p_role,
        'deployment_id', p_deployment_id
      ),
      v_operator.config_hash
    );
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
    p_trade_id
  );

  SELECT t.* INTO v_trade
  FROM asset_exchange.trades AS t
  WHERE t.trade_id = p_trade_id;

  RETURN QUERY SELECT v_trade.state::text, v_trade.trade_id::text;
END;
$$;

COMMIT;
