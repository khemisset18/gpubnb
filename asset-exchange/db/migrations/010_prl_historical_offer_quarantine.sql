-- GPUbnb Asset Exchange / Pearl PRL — additive, NOT DEPLOYED
-- Database backstop for historical PRL offers and direct SQL bypasses.
-- No real funds, no signer, no node, no migration execution authorised.
-- Review and test on an isolated disposable Exchange database BEFORE deployment.
BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;

CREATE FUNCTION asset_exchange.reject_unqualified_prl_asset_keys(
  p_give_asset_key text,
  p_want_asset_key text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $prl$
DECLARE
  v_key text;
  v_chain text;
BEGIN
  FOREACH v_key IN ARRAY ARRAY[p_give_asset_key, p_want_asset_key] LOOP
    IF v_key IS NULL
       OR length(v_key) = 0
       OR length(v_key) > 512
       OR array_length(string_to_array(v_key, '|'), 1) IS DISTINCT FROM 5 THEN
      RAISE EXCEPTION 'unqualified or malformed stored asset key'
        USING ERRCODE = '55000';
    END IF;

    -- Historical records may have inconsistently cased/trimmed chain labels.
    -- The primary runtime canonical chain is "pearl", never the ticker.
    -- "prl" is also denied as a fail-closed legacy alias, not enabled.
    v_chain := lower(btrim(split_part(v_key, '|', 1)));
    IF v_chain IN ('pearl', 'prl') THEN
      RAISE EXCEPTION 'Pearl exchange operations are not qualified'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$prl$;

-- Defense 1: direct SQL offer insertion cannot bypass the PRL API policy.
CREATE FUNCTION asset_exchange.guard_prl_offer_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $prl$
BEGIN
  PERFORM asset_exchange.reject_unqualified_prl_asset_keys(
    NEW.give_asset_key, NEW.want_asset_key
  );
  RETURN NEW;
END;
$prl$;

CREATE TRIGGER offers_reject_unqualified_prl_insert
BEFORE INSERT ON asset_exchange.offers
FOR EACH ROW
EXECUTE FUNCTION asset_exchange.guard_prl_offer_insert();

-- Defense 2: direct atomic acceptance creates a trade. The record's
-- underlying offer assets, not the supplied acceptance body, decide.
CREATE FUNCTION asset_exchange.guard_prl_trade_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $prl$
DECLARE
  v_give_asset_key text;
  v_want_asset_key text;
BEGIN
  SELECT o.give_asset_key, o.want_asset_key
    INTO v_give_asset_key, v_want_asset_key
    FROM asset_exchange.offers AS o
   WHERE o.offer_id = NEW.offer_id
     AND o.deployment_id = NEW.deployment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'acceptance offer identity unavailable'
      USING ERRCODE = '55000';
  END IF;

  PERFORM asset_exchange.reject_unqualified_prl_asset_keys(
    v_give_asset_key, v_want_asset_key
  );
  RETURN NEW;
END;
$prl$;

CREATE TRIGGER trades_reject_unqualified_prl_insert
BEFORE INSERT ON asset_exchange.trades
FOR EACH ROW
EXECUTE FUNCTION asset_exchange.guard_prl_trade_creation();

-- Defense 3: protect the consumption state if a code path bypasses
-- inserting into trades. Existing consumed records are not rewritten.
CREATE FUNCTION asset_exchange.guard_prl_offer_consumption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $prl$
BEGIN
  IF NEW.state = 'CONSUMED'
     AND OLD.state IS DISTINCT FROM 'CONSUMED' THEN
    PERFORM asset_exchange.reject_unqualified_prl_asset_keys(
      OLD.give_asset_key, OLD.want_asset_key
    );
  END IF;
  RETURN NEW;
END;
$prl$;

CREATE TRIGGER offers_reject_unqualified_prl_consumption
BEFORE UPDATE OF state, accepted_trade_id ON asset_exchange.offers
FOR EACH ROW
EXECUTE FUNCTION asset_exchange.guard_prl_offer_consumption();

COMMIT;
