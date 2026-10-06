-- gpu.k.p2p Asset Exchange
-- Financial immutability and append-only evidence guards.
-- NO REAL FUNDS / NO MAINNET.

BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;

CREATE OR REPLACE FUNCTION guard_offer_financial_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'offers are durable financial records and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
     OR NEW.maker_subject IS DISTINCT FROM OLD.maker_subject
     OR NEW.offer_hash IS DISTINCT FROM OLD.offer_hash
     OR NEW.signed_offer IS DISTINCT FROM OLD.signed_offer
     OR NEW.signature IS DISTINCT FROM OLD.signature
     OR NEW.signature_scheme IS DISTINCT FROM OLD.signature_scheme
     OR NEW.give_asset_key IS DISTINCT FROM OLD.give_asset_key
     OR NEW.give_amount_atomic IS DISTINCT FROM OLD.give_amount_atomic
     OR NEW.want_asset_key IS DISTINCT FROM OLD.want_asset_key
     OR NEW.want_amount_atomic IS DISTINCT FROM OLD.want_amount_atomic
     OR NEW.nonce IS DISTINCT FROM OLD.nonce
     OR NEW.policy_epoch IS DISTINCT FROM OLD.policy_epoch
     OR NEW.fee_policy_id IS DISTINCT FROM OLD.fee_policy_id
     OR NEW.fee_policy_version IS DISTINCT FROM OLD.fee_policy_version
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'signed offer fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state <> 'OPEN'
       OR NEW.state NOT IN ('CANCELLED','CONSUMED','EXPIRED') THEN
      RAISE EXCEPTION 'invalid offer lifecycle mutation'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF OLD.accepted_trade_id IS NOT NULL THEN
    IF NEW.accepted_trade_id IS DISTINCT FROM OLD.accepted_trade_id
       OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
      RAISE EXCEPTION 'offer consumption evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.accepted_trade_id IS NOT NULL THEN
    IF OLD.state <> 'OPEN'
       OR NEW.state <> 'CONSUMED'
       OR NEW.consumed_at IS NULL THEN
      RAISE EXCEPTION 'consumption evidence may only be set on OPEN to CONSUMED'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF OLD.cancelled_at IS NOT NULL THEN
    IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
      RAISE EXCEPTION 'offer cancellation timestamp is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.cancelled_at IS NOT NULL THEN
    IF OLD.state <> 'OPEN' OR NEW.state <> 'CANCELLED' THEN
      RAISE EXCEPTION 'cancellation timestamp may only be set on OPEN to CANCELLED'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF OLD.cancellation_hash IS NOT NULL
     OR OLD.cancellation_signature IS NOT NULL THEN
    IF NEW.cancellation_hash IS DISTINCT FROM OLD.cancellation_hash
       OR NEW.cancellation_signature IS DISTINCT FROM OLD.cancellation_signature THEN
      RAISE EXCEPTION 'signed cancellation evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.cancellation_hash IS NOT NULL
        OR NEW.cancellation_signature IS NOT NULL THEN
    IF OLD.state <> 'OPEN'
       OR NEW.state <> 'CANCELLED'
       OR NEW.cancellation_hash IS NULL
       OR NEW.cancellation_signature IS NULL
       OR octet_length(NEW.cancellation_signature) = 0 THEN
      RAISE EXCEPTION 'cancellation evidence may only be set atomically on cancellation'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER offers_financial_immutable
BEFORE UPDATE OR DELETE ON offers
FOR EACH ROW EXECUTE FUNCTION guard_offer_financial_immutability();

CREATE OR REPLACE FUNCTION guard_trade_financial_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trades are durable financial records and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.trade_id IS DISTINCT FROM OLD.trade_id
     OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
     OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
     OR NEW.offer_hash IS DISTINCT FROM OLD.offer_hash
     OR NEW.maker_subject IS DISTINCT FROM OLD.maker_subject
     OR NEW.taker_subject IS DISTINCT FROM OLD.taker_subject
     OR NEW.policy_epoch IS DISTINCT FROM OLD.policy_epoch
     OR NEW.fee_policy_id IS DISTINCT FROM OLD.fee_policy_id
     OR NEW.fee_policy_version IS DISTINCT FROM OLD.fee_policy_version
     OR NEW.acceptance_hash IS DISTINCT FROM OLD.acceptance_hash
     OR NEW.acceptance_signature IS DISTINCT FROM OLD.acceptance_signature
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'signed trade identity/acceptance fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.terms_hash IS NOT NULL
     AND NEW.terms_hash IS DISTINCT FROM OLD.terms_hash THEN
    RAISE EXCEPTION 'trade terms hash is write-once'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.signed_terms_a IS NOT NULL
     AND NEW.signed_terms_a IS DISTINCT FROM OLD.signed_terms_a THEN
    RAISE EXCEPTION 'maker signed terms are write-once'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.signed_terms_b IS NOT NULL
     AND NEW.signed_terms_b IS DISTINCT FROM OLD.signed_terms_b THEN
    RAISE EXCEPTION 'taker signed terms are write-once'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trades_financial_immutable
BEFORE UPDATE OR DELETE ON trades
FOR EACH ROW EXECUTE FUNCTION guard_trade_financial_immutability();

CREATE OR REPLACE FUNCTION reject_trade_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'trade events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trade_events_append_only
BEFORE UPDATE OR DELETE ON trade_events
FOR EACH ROW EXECUTE FUNCTION reject_trade_event_mutation();

COMMIT;
