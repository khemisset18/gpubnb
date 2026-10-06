-- gpu.k.p2p Asset Exchange
-- G5 foundation schema
-- Target: PostgreSQL 16+
-- IMPORTANT: deploy to a physically/logically separate Asset Exchange database.
-- Never run this migration against the GPUbnb Core database.

BEGIN;

CREATE SCHEMA IF NOT EXISTS asset_exchange;
SET LOCAL search_path = asset_exchange, pg_catalog;

CREATE DOMAIN atomic_u128 AS numeric(39,0)
  CHECK (
    VALUE >= 0
    AND VALUE <= 340282366920938463463374607431768211455
    AND scale(VALUE) = 0
  );

CREATE TABLE fee_policies (
  policy_id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  payer_role text NOT NULL CHECK (payer_role IN ('MAKER','TAKER','SELLER','BUYER')),
  fee_asset_key text NOT NULL,
  recipient text NOT NULL,
  minimum_atomic atomic_u128,
  maximum_atomic atomic_u128,
  policy_hash char(64) NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (policy_id, version),
  UNIQUE (policy_hash),
  CHECK (minimum_atomic IS NULL OR maximum_atomic IS NULL OR minimum_atomic <= maximum_atomic)
);

CREATE TABLE offers (
  offer_id text PRIMARY KEY,
  deployment_id text NOT NULL,
  maker_subject text NOT NULL,
  offer_hash char(64) NOT NULL UNIQUE CHECK (offer_hash ~ '^[0-9a-f]{64}$'),
  signed_offer bytea NOT NULL,
  signature bytea NOT NULL,
  signature_scheme text NOT NULL,
  give_asset_key text NOT NULL,
  give_amount_atomic atomic_u128 NOT NULL CHECK (give_amount_atomic > 0),
  want_asset_key text NOT NULL,
  want_amount_atomic atomic_u128 NOT NULL CHECK (want_amount_atomic > 0),
  nonce text NOT NULL,
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  fee_policy_id text NOT NULL,
  fee_policy_version bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('OPEN','CANCELLED','CONSUMED','EXPIRED')),
  accepted_trade_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  cancelled_at timestamptz,
  FOREIGN KEY (fee_policy_id, fee_policy_version)
    REFERENCES fee_policies(policy_id, version),
  UNIQUE (accepted_trade_id),
  CHECK (
    (state = 'CONSUMED' AND accepted_trade_id IS NOT NULL AND consumed_at IS NOT NULL)
    OR
    (state <> 'CONSUMED' AND accepted_trade_id IS NULL AND consumed_at IS NULL)
  )
);

CREATE INDEX offers_open_expiry_idx
  ON offers (expires_at, offer_id)
  WHERE state = 'OPEN';

CREATE TABLE trades (
  trade_id text PRIMARY KEY,
  deployment_id text NOT NULL,
  offer_id text NOT NULL UNIQUE REFERENCES offers(offer_id),
  offer_hash char(64) NOT NULL CHECK (offer_hash ~ '^[0-9a-f]{64}$'),
  maker_subject text NOT NULL,
  taker_subject text NOT NULL,
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  fee_policy_id text NOT NULL,
  fee_policy_version bigint NOT NULL,
  state text NOT NULL,
  terms_hash char(64),
  signed_terms_a bytea,
  signed_terms_b bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (fee_policy_id, fee_policy_version)
    REFERENCES fee_policies(policy_id, version)
);

ALTER TABLE offers
  ADD CONSTRAINT offers_accepted_trade_fk
  FOREIGN KEY (accepted_trade_id) REFERENCES trades(trade_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE trade_events (
  event_id text PRIMARY KEY,
  trade_id text NOT NULL REFERENCES trades(trade_id),
  sequence_no bigint NOT NULL CHECK (sequence_no >= 1),
  event_type text NOT NULL,
  previous_state text,
  new_state text NOT NULL,
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  idempotency_key text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_hash char(64) NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (trade_id, sequence_no),
  UNIQUE (trade_id, idempotency_key)
);

CREATE TABLE idempotency_records (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_ref text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE operator_state (
  singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode text NOT NULL CHECK (mode IN ('CONFORMITE','SOUVERAIN','TRANSITION')),
  target_mode text CHECK (target_mode IN ('CONFORMITE','SOUVERAIN')),
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  new_offers_enabled boolean NOT NULL DEFAULT FALSE,
  new_accepts_enabled boolean NOT NULL DEFAULT FALSE,
  new_locks_enabled boolean NOT NULL DEFAULT FALSE,
  config_hash char(64) NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (mode = 'TRANSITION' AND target_mode IS NOT NULL AND new_offers_enabled = FALSE AND new_accepts_enabled = FALSE AND new_locks_enabled = FALSE)
    OR
    (mode <> 'TRANSITION' AND target_mode IS NULL)
  )
);

CREATE OR REPLACE FUNCTION reject_fee_policy_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = asset_exchange, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'fee policy rows are immutable; insert a new version instead'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER fee_policies_immutable
BEFORE UPDATE OR DELETE ON fee_policies
FOR EACH ROW EXECUTE FUNCTION reject_fee_policy_mutation();

COMMIT;
