-- SYNTHETIC HISTORIC records ONLY. For a fresh, dedicated scratch DB.
-- Apply migrations 001-009 first; this fixture MUST run BEFORE 010.
-- Never use on a populated or production database.
DO $guard$
BEGIN
  IF current_database() !~ '^prl_scratch_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'PRL_TEST_REQUIRES_DISPOSABLE_DATABASE';
  END IF;
END;
$guard$;

BEGIN;
SET LOCAL search_path = asset_exchange, pg_catalog;
INSERT INTO fee_policies
  (policy_id, version, rate_bps, payer_role, fee_asset_key, recipient, policy_hash)
VALUES
  ('prl-scratch-policy', 1, 0, 'TAKER', 'bitcoin|regtest|NATIVE|BTC_NATIVE|8',
   'lab:treasury:fake', repeat('f',64));
INSERT INTO operator_state
  (singleton, mode, target_mode, policy_epoch,
   new_offers_enabled, new_accepts_enabled, new_locks_enabled, config_hash)
VALUES (TRUE, 'CONFORMITE', NULL, 7, FALSE, FALSE, FALSE, repeat('2',64));

INSERT INTO offers (
  offer_id, deployment_id, maker_subject, offer_hash, signed_offer, signature,
  signature_scheme, give_asset_key, give_amount_atomic, want_asset_key,
  want_amount_atomic, nonce, policy_epoch, fee_policy_id,
  fee_policy_version, expires_at, state, accepted_trade_id, consumed_at
)
SELECT o.offer_id, 'ae-test-01', 'maker:test:prl', repeat(o.hash_char,64),
       decode('00','hex'), decode('01','hex'), 'NOT_A_SIGNATURE',
       o.give_key, 100, o.want_key, 250,
       'ABCDEFGHIJKLMNOP', 7, 'prl-scratch-policy', 1,
       clock_timestamp() + interval '1 day', 'CONSUMED',
       o.trade_id, clock_timestamp()
FROM (VALUES
  ('prl-old-give-0001','prl-trade-give-0001','a',
   'pearl|mainnet|NATIVE|PRL_NATIVE_UNVERIFIED|8',
   'bitcoin|regtest|NATIVE|BTC_NATIVE|8'),
  ('prl-old-want-0001','prl-trade-want-0001','b',
   'bitcoin|regtest|NATIVE|BTC_NATIVE|8',
   'pearl|mainnet|NATIVE|PRL_NATIVE_UNVERIFIED|8'),
  ('prl-old-other-0001','prl-trade-other-0001','c',
   'bitcoin|regtest|NATIVE|BTC_NATIVE|8',
   'litecoin|regtest|NATIVE|LTC_NATIVE|8')
) AS o(offer_id,trade_id,hash_char,give_key,want_key);

INSERT INTO trades (
  trade_id, deployment_id, offer_id, offer_hash, maker_subject,
  taker_subject, policy_epoch, fee_policy_id, fee_policy_version,
  state, acceptance_hash, acceptance_signature
)
SELECT t.trade_id, 'ae-test-01', t.offer_id, repeat(t.hash_char,64),
       'maker:test:prl', t.taker_subject, 7,
       'prl-scratch-policy', 1, 'ACCEPTED_PENDING_TERMS',
       repeat('d',64), decode('11','hex')
FROM (VALUES
  ('prl-trade-give-0001','prl-old-give-0001','a','taker:test:prlgive'),
  ('prl-trade-want-0001','prl-old-want-0001','b','taker:test:prlwant'),
  ('prl-trade-other-0001','prl-old-other-0001','c','taker:test:other')
) AS t(trade_id,offer_id,hash_char,taker_subject);

INSERT INTO idempotency_records
  (scope, idempotency_key, request_hash, result_ref)
VALUES
  ('accept_offer:ae-test-01:taker:test:prlgive',
   'prl-scratch-give-key', repeat('e',64), 'prl-trade-give-0001'),
  ('accept_offer:ae-test-01:taker:test:prlwant',
   'prl-scratch-want-key', repeat('e',64), 'prl-trade-want-0001'),
  ('accept_offer:ae-test-01:taker:test:other',
   'prl-scratch-other-key', repeat('e',64), 'prl-trade-other-0001');

-- A legacy OPEN Pearl offer is also staged before the quarantine triggers.
INSERT INTO offers (
  offer_id, deployment_id, maker_subject, offer_hash, signed_offer,
  signature, signature_scheme, give_asset_key, give_amount_atomic,
  want_asset_key, want_amount_atomic, nonce, policy_epoch,
  fee_policy_id, fee_policy_version, expires_at, state
) VALUES (
  'prl-old-open-0001', 'ae-test-01', 'maker:test:prl', repeat('9',64),
  decode('00','hex'), decode('01','hex'), 'NOT_A_SIGNATURE',
  'pearl|mainnet|NATIVE|PRL_NATIVE_UNVERIFIED|8', 100,
  'bitcoin|regtest|NATIVE|BTC_NATIVE|8', 250,
  'ABCDEFGHIJKLMNOP', 7, 'prl-scratch-policy', 1,
  clock_timestamp() + interval '1 day', 'OPEN'
);


COMMIT;
