-- gpu.k.p2p Asset Exchange
-- G5 SSO ticket replay protection.
-- Exchange-only DB. No Core session/cookie data.

BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;

CREATE TABLE consumed_sso_tickets (
  deployment_id text NOT NULL,
  jti text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (deployment_id, jti)
);

CREATE INDEX consumed_sso_tickets_expiry_idx
  ON consumed_sso_tickets (expires_at);

COMMIT;
