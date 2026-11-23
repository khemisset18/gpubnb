import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const path = (name) => new URL("../../db/migrations/" + name, import.meta.url);
const original = readFileSync(path("002_atomic_offer_operations.sql"), "utf8");
const quarantine = readFileSync(path("010_prl_historical_offer_quarantine.sql"), "utf8");
const replay = readFileSync(path("011_prl_accept_replay_quarantine.sql"), "utf8");
const scratchRun = readFileSync(new URL("../../db/test/prl_scratch_replay_run.sh", import.meta.url), "utf8");
const concurrency = readFileSync(new URL("../../db/test/concurrency.sh", import.meta.url), "utf8");
const scratchSeed = readFileSync(new URL("../../db/test/prl_scratch_historical_before_010.sql", import.meta.url), "utf8");
const scratchAssert = readFileSync(new URL("../../db/test/prl_scratch_accept_replay_after_011.sql", import.meta.url), "utf8");

// These are OFFLINE STATIC CONTRACT assertions, not execution of SQL.
// Native PostgreSQL 16+ testing is still required.
const start = "CREATE OR REPLACE FUNCTION accept_offer_atomic(";
const next = "CREATE OR REPLACE FUNCTION cancel_offer_atomic(";
function extract(sql) {
  const startAt = sql.indexOf(start);
  assert.notEqual(startAt, -1);
  const after = sql.indexOf("\n$$;", startAt);
  assert.notEqual(after, -1);
  return sql.slice(startAt, after + 4);
}
const oldFn = extract(original), newFn = extract(replay);

test("migration 011 preserves the original public accept function signature", () => {
  const signature = (s) => s.slice(0, s.indexOf("\nLANGUAGE plpgsql"));
  assert.equal(signature(newFn), signature(oldFn));
});
test("011 is one additive transaction with no replacement of cancel function", () => {
  assert.equal((replay.match(/^BEGIN;$/gm) ?? []).length, 1);
  assert.equal((replay.match(/^COMMIT;$/gm) ?? []).length, 1);
  assert.equal((replay.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 1);
  assert.equal(replay.includes(next), false);
  assert.match(replay, /SET LOCAL search_path = asset_exchange, pg_catalog/);
});
test("010 creates the trusted shared key guard before 011 references it", () => {
  assert.match(quarantine, /CREATE FUNCTION asset_exchange\.reject_unqualified_prl_asset_keys/);
  assert.match(quarantine, /v_parts\[4\] <> btrim\(v_parts\[4\]\)/);
  assert.match(newFn, /PERFORM asset_exchange\.reject_unqualified_prl_asset_keys/);
});
test("replay branch checks request hash before offer lookup", () => {
  const validate = newFn.indexOf("IF p_request_hash IS NULL");
  const hash = newFn.indexOf("v_existing.request_hash <> p_request_hash");
  const read = newFn.indexOf("SELECT o.* INTO v_offer");
  const returned = newFn.indexOf("RETURN QUERY SELECT 'CONSUMED'::text, v_existing.result_ref");
  assert.ok(validate > -1 && validate < hash && read > hash && returned > read);
  assert.match(newFn, /p_request_hash::text !~ '\^\[0-9a-f\]\{64\}\$'/);
});
test("replay serializes the same idempotency key across sessions before lookup", () => {
  const lock = newFn.indexOf("pg_catalog.pg_advisory_xact_lock");
  const lookup = newFn.indexOf("SELECT * INTO v_existing");
  assert.ok(lock > -1 && lookup > lock);
  assert.match(newFn, /hashtext\(v_scope\)/);
  assert.match(newFn, /hashtext\(p_idempotency_key\)/);
});
test("replay identity bound to the exact authenticated scope and idempotency key", () => {
  assert.match(newFn, /v_scope text := 'accept_offer:' \|\| p_deployment_id \|\| ':' \|\| p_taker_subject/);
  assert.match(newFn, /WHERE scope = v_scope AND idempotency_key = p_idempotency_key/);
  assert.match(newFn, /v_existing\.result_ref = p_trade_id/);
});
test("replay reads actual offer and trade, not untrusted acceptance asset claims", () => {
  assert.match(newFn, /JOIN asset_exchange\.trades AS t/);
  assert.match(newFn, /t\.offer_id = o\.offer_id/);
  assert.match(newFn, /o\.offer_id = p_offer_id/);
  assert.match(newFn, /o\.deployment_id = p_deployment_id/);
  assert.match(newFn, /o\.state = 'CONSUMED'/);
  assert.match(newFn, /o\.accepted_trade_id = p_trade_id/);
  assert.match(newFn, /FOR UPDATE OF o/);
});
test("replay crosschecks trade taker, hash, epoch, acceptance proof", () => {
  for (const clause of [
    "t.trade_id = p_trade_id",
    "t.taker_subject = p_taker_subject",
    "t.offer_hash = p_offer_hash",
    "t.policy_epoch = p_policy_epoch",
    "t.acceptance_hash = p_acceptance_hash",
    "t.acceptance_signature = p_acceptance_signature"
  ]) assert.ok(newFn.includes(clause), clause);
});
test("replay refuses mismatches before returning an earlier consumed result", () => {
  const noRow = newFn.indexOf("idempotency replay offer/trade identity mismatch");
  const guard = newFn.indexOf("PERFORM asset_exchange.reject_unqualified_prl_asset_keys");
  const returned = newFn.indexOf("RETURN QUERY SELECT 'CONSUMED'::text, v_existing.result_ref");
  assert.ok(noRow > -1 && guard > noRow && returned > guard);
});
test("new acceptances separately inspect stored PRL keys before trade insert", () => {
  const secondRead = newFn.lastIndexOf("SELECT o.* INTO v_offer");
  const secondGuard = newFn.lastIndexOf("PERFORM asset_exchange.reject_unqualified_prl_asset_keys");
  const insert = newFn.indexOf("INSERT INTO asset_exchange.trades");
  assert.ok(secondRead > 0 && secondGuard > secondRead && insert > secondGuard);
});
test("operator transition, epoch, signature and acceptance preconditions preserved", () => {
  for (const clause of [
    "v_operator.new_accepts_enabled IS NOT TRUE",
    "v_operator.policy_epoch <> p_policy_epoch",
    "p_acceptance_signature IS NULL",
    "v_offer.state <> 'OPEN'",
    "v_offer.expires_at <= clock_timestamp()",
    "v_offer.offer_hash <> p_offer_hash",
    "v_offer.policy_epoch <> p_policy_epoch"
  ]) assert.ok(newFn.includes(clause), clause);
});
test("whole-fill, trade event and idempotency write still present", () => {
  for (const clause of [
    "UPDATE asset_exchange.offers",
    "INSERT INTO asset_exchange.trades",
    "INSERT INTO asset_exchange.trade_events",
    "INSERT INTO asset_exchange.idempotency_records"
  ]) assert.ok(newFn.includes(clause), clause);
});
test("migration does not elevate SQL privileges or mutate historic data", () => {
  assert.doesNotMatch(replay, /\bSECURITY DEFINER\b/);
  assert.doesNotMatch(replay, /\bDROP (TABLE|TRIGGER|FUNCTION)\b/);
  assert.doesNotMatch(replay, /\bTRUNCATE\b/);
  assert.doesNotMatch(replay, /\bGRANT\b/);
  assert.doesNotMatch(replay, /\bDELETE FROM\b/);
  assert.match(newFn, /\bSECURITY INVOKER\b/);
});


test("scratch runner requires explicit opt-in and a scratch socket/database", () => {
  assert.match(scratchRun, /PRL_SCRATCH_ACK/);
  assert.match(scratchRun, /DISPOSABLE_EXCHANGE_DB_ONLY/);
  assert.match(scratchRun, /\/tmp\/gpubnb-prl-scratch-/);
  assert.match(scratchRun, /prl_scratch_/);
  assert.match(scratchRun, /Exchange schema already exists/);
  assert.doesNotMatch(scratchRun, /\bsudo\b|\bdocker\b|\bapt-get\b/);
});
test("native runners reject libpq host overrides and prove their private socket target", () => {
  for (const source of [scratchRun, concurrency]) {
    assert.match(source, /PGHOSTADDR/);
    assert.match(source, /PRL_SCRATCH_DATA_DIR/);
    assert.match(source, /inet_server_addr\(\)/);
    assert.match(source, /unix_socket_directories/);
    assert.match(source, /PGDATABASE.*prl_scratch_/s);
  }
  assert.match(concurrency, /PRL_SCRATCH_ACK/);
  assert.match(concurrency, /--network none/);
  assert.doesNotMatch(concurrency, /--network host/);
  assert.doesNotMatch(concurrency, /PGDATABASE=\$\{PGDATABASE:-asset_exchange\}/);
});
test("scratch runner uses 001-009, synthetic seed, then quarantines 010-011", () => {
  const baseline = scratchRun.indexOf("00[1-9]_*.sql");
  const seed = scratchRun.indexOf("prl_scratch_historical_before_010.sql");
  const first = scratchRun.indexOf("010_prl_historical_offer_quarantine.sql");
  const second = scratchRun.lastIndexOf("011_prl_accept_replay_quarantine.sql");
  const check = scratchRun.indexOf("prl_scratch_accept_replay_after_011.sql");
  assert.ok(baseline < seed && seed < first && first < second && second < check);
  assert.match(scratchRun, /ON_ERROR_STOP=1/);
});
test("pre-quarantine fixture seeds historic PRL on both sides and nonPRL control", () => {
  for (const needle of [
    "prl-old-give-0001", "prl-old-want-0001",
    "prl-old-other-0001", "prl-old-open-0001",
    "pearl|mainnet|NATIVE|PRL_NATIVE_UNVERIFIED|8",
    "bitcoin|regtest|NATIVE|BTC_NATIVE|8"
  ]) assert.ok(scratchSeed.includes(needle), needle);
  assert.match(scratchSeed, /PRL_TEST_REQUIRES_DISPOSABLE_DATABASE/);
});
test("native test scenario includes PRL replays, nonPRL replay and direct trigger attempts", () => {
  for (const needle of [
    "prl-trade-other-0001", "prl-trade-give-0001", "prl-trade-want-0001",
    "prl-forbidden-trade-1", "prl-forbidden-offer-1",
    "prl-forbidden-accept-1", "expected consumption trigger refusal"
  ]) assert.ok(scratchAssert.includes(needle), needle);
  assert.match(scratchAssert, /PRL_TEST_REQUIRES_DISPOSABLE_DATABASE/);
});
test("native replay scenario separates hash, epoch, signature and malformed-key refusals", () => {
  for (const needle of [
    "offer hash", "policy epoch", "acceptance hash", "acceptance signature",
    "malformed stored asset key", "BTC_NATIVE |8",
    "idempotency replay offer/trade identity mismatch"
  ]) assert.ok(scratchAssert.includes(needle), needle);
});
test("native concurrency script checks two-session same-key idempotent replay", () => {
  assert.match(concurrency, /concurrent identical acceptance is durably idempotent/);
  assert.match(concurrency, /accept-key-concurrent01/);
  assert.match(concurrency, /idempotency_records WHERE idempotency_key='accept-key-concurrent01'/);
  assert.match(concurrency, /network none/);
});
test("native scratch assertions rollback and never call a signer, miner or wallet", () => {
  assert.match(scratchAssert, /^BEGIN;$/m);
  assert.match(scratchAssert, /^ROLLBACK;$/m);
  assert.doesNotMatch(scratchAssert, /^COMMIT;$/m);
  assert.doesNotMatch(scratchAssert, /\bCREATE DATABASE\b|\bDROP DATABASE\b/);
  assert.doesNotMatch(scratchAssert, /sendrawtransaction|broadcast|walletpassphrase/);
});
