-- gpu.k.p2p Asset Exchange
-- G5 admin fee policy activation + append-only audit.
-- NO REAL FUNDS / NO MAINNET.

BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;

ALTER TABLE operator_state
  ADD COLUMN active_fee_policy_id text,
  ADD COLUMN active_fee_policy_version bigint;

ALTER TABLE operator_state
  ADD CONSTRAINT operator_active_fee_policy_fk
  FOREIGN KEY (active_fee_policy_id, active_fee_policy_version)
  REFERENCES fee_policies(policy_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE admin_audit_events (
  audit_id text PRIMARY KEY,
  deployment_id text NOT NULL,
  actor_subject text NOT NULL,
  credential_id text NOT NULL,
  action text NOT NULL,
  challenge_hash char(64) NOT NULL CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  before_config_hash char(64) NOT NULL CHECK (before_config_hash ~ '^[0-9a-f]{64}$'),
  after_config_hash char(64) NOT NULL CHECK (after_config_hash ~ '^[0-9a-f]{64}$'),
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION reject_admin_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'admin audit rows are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER admin_audit_immutable
BEFORE UPDATE OR DELETE ON admin_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_admin_audit_mutation();

CREATE OR REPLACE FUNCTION activate_fee_policy_atomic(
  p_deployment_id text,
  p_actor_subject text,
  p_credential_id text,
  p_challenge_hash char(64),
  p_expected_config_hash char(64),
  p_policy_id text,
  p_policy_version bigint,
  p_rate_bps integer,
  p_payer_role text,
  p_fee_asset_key text,
  p_recipient text,
  p_minimum_atomic atomic_u128,
  p_maximum_atomic atomic_u128,
  p_policy_hash char(64),
  p_after_config_hash char(64),
  p_audit_id text
)
RETURNS TABLE(status text, policy_id text, policy_version bigint, rate_bps integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $$
DECLARE
  v_operator asset_exchange.operator_state%ROWTYPE;
BEGIN
  SELECT * INTO v_operator
  FROM asset_exchange.operator_state
  WHERE singleton = TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator state missing' USING ERRCODE = '55000';
  END IF;

  IF v_operator.mode = 'TRANSITION' THEN
    RAISE EXCEPTION 'fee policy change blocked during transition'
      USING ERRCODE = '55000';
  END IF;

  IF v_operator.config_hash <> p_expected_config_hash THEN
    RAISE EXCEPTION 'stale admin challenge/config'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO asset_exchange.fee_policies (
    policy_id, version, rate_bps, payer_role, fee_asset_key, recipient,
    minimum_atomic, maximum_atomic, policy_hash
  ) VALUES (
    p_policy_id, p_policy_version, p_rate_bps, p_payer_role, p_fee_asset_key, p_recipient,
    p_minimum_atomic, p_maximum_atomic, p_policy_hash
  );

  UPDATE asset_exchange.operator_state
  SET active_fee_policy_id = p_policy_id,
      active_fee_policy_version = p_policy_version,
      config_hash = p_after_config_hash,
      updated_at = clock_timestamp()
  WHERE singleton = TRUE;

  INSERT INTO asset_exchange.admin_audit_events (
    audit_id, deployment_id, actor_subject, credential_id, action,
    challenge_hash, before_config_hash, after_config_hash, details
  ) VALUES (
    p_audit_id, p_deployment_id, p_actor_subject, p_credential_id,
    'ACTIVATE_FEE_POLICY',
    p_challenge_hash, p_expected_config_hash, p_after_config_hash,
    jsonb_build_object(
      'policy_id', p_policy_id,
      'policy_version', p_policy_version,
      'rate_bps', p_rate_bps,
      'payer_role', p_payer_role,
      'fee_asset_key', p_fee_asset_key,
      'recipient', p_recipient,
      'policy_hash', p_policy_hash
    )
  );

  RETURN QUERY SELECT 'ACTIVE'::text, p_policy_id::text, p_policy_version::bigint, p_rate_bps::integer;
END;
$$;

COMMIT;
