SET search_path = asset_exchange, pg_catalog;

TRUNCATE TABLE
  trade_events,
  idempotency_records,
  trades,
  offers,
  operator_state,
  fee_policies
CASCADE;

INSERT INTO fee_policies (
  policy_id, version, rate_bps, payer_role, fee_asset_key, recipient, policy_hash
) VALUES (
  'default-taker-v1',
  1,
  35,
  'TAKER',
  'bitcoin|regtest|NATIVE|BTC_NATIVE|8',
  'treasury:test',
  repeat('1', 64)
);

INSERT INTO operator_state (
  singleton, mode, target_mode, policy_epoch,
  new_offers_enabled, new_accepts_enabled, new_locks_enabled, config_hash
) VALUES (
  TRUE, 'SOUVERAIN', NULL, 7,
  TRUE, TRUE, FALSE, repeat('2', 64)
);

INSERT INTO offers (
  offer_id, deployment_id, maker_subject, offer_hash,
  signed_offer, signature, signature_scheme,
  give_asset_key, give_amount_atomic,
  want_asset_key, want_amount_atomic,
  nonce, policy_epoch,
  fee_policy_id, fee_policy_version,
  expires_at, state
) VALUES (
  'offer-00000001',
  'ae-test-01',
  'maker:test:001',
  repeat('a', 64),
  decode('00', 'hex'),
  decode('01', 'hex'),
  'TEST_ONLY',
  'bitcoin|regtest|NATIVE|BTC_NATIVE|8',
  100000000,
  'litecoin|regtest|NATIVE|LTC_NATIVE|8',
  2500000000,
  'ABCDEFGHIJKLMNOP',
  7,
  'default-taker-v1',
  1,
  clock_timestamp() + interval '1 hour',
  'OPEN'
);
