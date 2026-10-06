-- gpu.k.p2p Asset Exchange
-- G5 Exchange-only session persistence.
-- Stores hashes only. Never stores raw cookie or CSRF tokens.

BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;

CREATE TABLE exchange_sessions (
  session_hash char(64) PRIMARY KEY
    CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  deployment_id text NOT NULL,
  subject text NOT NULL,
  authn_method text NOT NULL
    CHECK (authn_method IN ('EXCHANGE_SESSION','SIGNED_SSO_TICKET')),
  csrf_hash char(64) NOT NULL
    CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX exchange_sessions_subject_active_idx
  ON exchange_sessions (deployment_id, subject, expires_at)
  WHERE revoked_at IS NULL;

COMMIT;
