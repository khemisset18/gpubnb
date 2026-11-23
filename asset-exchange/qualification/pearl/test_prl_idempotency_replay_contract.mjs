import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../../db/migrations/012_idempotency_replay_hardening.sql");
const scratch = read("../../db/test/idempotency_replay_after_012.sql");
const runner = read("../../db/test/prl_scratch_replay_run.sh");
const concurrency = read("../../db/test/concurrency.sh");

// These assertions inspect source text only. They do not execute PostgreSQL.
function fn(name) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.notEqual(start, -1, `${name} is present`);
  const end = migration.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${name} is terminated`);
  return migration.slice(start, end + 4);
}

test("012 is transactional, additive and invoker-only", () => {
  assert.match(migration, /^BEGIN;$/m);
  assert.match(migration, /^COMMIT;$/m);
  assert.equal((migration.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 3);
  assert.equal((migration.match(/SECURITY INVOKER/g) ?? []).length, 3);
  assert.doesNotMatch(migration, /\bSECURITY DEFINER\b|\bGRANT\b|\bDROP (TABLE|TRIGGER|FUNCTION)\b|\bTRUNCATE\b|\bDELETE FROM\b/i);
});

test("all three write paths validate and serialize before idempotency lookup", () => {
  for (const name of ["publish_offer_atomic", "cancel_offer_atomic", "submit_trade_terms_signature_atomic"]) {
    const body = fn(name);
    const validation = body.indexOf("p_request_hash IS NULL");
    const lock = body.indexOf("pg_catalog.pg_advisory_xact_lock");
    const lookup = body.indexOf("SELECT * INTO v_existing");
    assert.ok(validation >= 0 && validation < lock && lock < lookup, name);
    assert.match(body, /p_idempotency_key IS NULL/);
    assert.match(body, /v_existing\.request_hash IS DISTINCT FROM p_request_hash/);
  }
});

test("publication replay checks persisted signed fields and expires only fresh writes", () => {
  const body = fn("publish_offer_atomic");
  for (const clause of [
    "o.offer_hash = p_offer_hash", "o.signed_offer = p_signed_offer",
    "o.signature = p_signature", "o.give_asset_key = p_give_asset_key",
    "o.want_asset_key = p_want_asset_key", "o.expires_at = p_expires_at",
    "v_existing.result_ref = p_offer_id"
  ]) assert.ok(body.includes(clause), clause);
  assert.ok(body.indexOf("IF FOUND THEN") < body.indexOf("p_expires_at <= clock_timestamp()"));
  assert.match(body, /reject_unqualified_prl_asset_keys/);
});

test("cancellation replay is bound to the persisted result and evidence", () => {
  const body = fn("cancel_offer_atomic");
  for (const clause of [
    "o.state = 'CANCELLED'", "o.cancellation_hash = p_cancellation_hash",
    "o.cancellation_signature = p_cancellation_signature",
    "v_existing.result_ref = p_offer_id", "FOR UPDATE"
  ]) assert.ok(body.includes(clause), clause);
  assert.match(body, /IF v_offer\.state <> 'OPEN'/);
  assert.match(body, /maker authorization mismatch/);
});

test("terms replay is bound to deployment, role, actor, result, hash and signature", () => {
  const body = fn("submit_trade_terms_signature_atomic");
  for (const clause of [
    "t.trade_id = p_trade_id AND t.deployment_id = p_deployment_id",
    "v_existing.result_ref IS DISTINCT FROM p_trade_id",
    "v_trade.maker_subject IS DISTINCT FROM p_actor_subject",
    "v_trade.taker_subject IS DISTINCT FROM p_actor_subject",
    "v_trade.terms_hash IS DISTINCT FROM p_terms_hash",
    "v_trade.signed_terms_a IS DISTINCT FROM p_signature",
    "v_trade.signed_terms_b IS DISTINCT FROM p_signature"
  ]) assert.ok(body.includes(clause), clause);
  assert.match(body, /p_role IS NULL OR p_role NOT IN \('MAKER','TAKER'\)/);
});

test("native regression harness is scratch-only and rolls back all scenario writes", () => {
  assert.match(scratch, /current_database\(\) !~ '\^prl_scratch_/);
  assert.match(scratch, /^BEGIN;$/m);
  assert.match(scratch, /^ROLLBACK;$/m);
  assert.doesNotMatch(scratch, /^COMMIT;$/m);
  for (const marker of [
    "expired exact publication replay failed", "expected NULL publication hash refusal",
    "expected publication proof mismatch refusal", "expected publication request hash mismatch",
    "expected fresh expired publication refusal", "expected direct SQL PRL publication refusal",
    "exact cancellation replay failed", "cancellation signature mismatch refusal",
    "expected terms signature replay mismatch refusal", "expected terms request hash mismatch",
    "expected NULL terms role refusal"
  ]) assert.ok(scratch.includes(marker), marker);
});

test("runner applies and tests migration 012 after the historical quarantine", () => {
  const migration011 = runner.indexOf("011_prl_accept_replay_quarantine.sql");
  const migration012 = runner.indexOf("012_idempotency_replay_hardening.sql");
  const previousScenario = runner.indexOf("prl_scratch_accept_replay_after_011.sql");
  const currentScenario = runner.indexOf("idempotency_replay_after_012.sql");
  assert.ok(migration011 >= 0 && migration012 > migration011);
  assert.ok(previousScenario > migration012 && currentScenario > previousScenario);
});

test("native two-session harness covers same-key publish, cancel and terms retries", () => {
  for (const marker of [
    "concurrent identical publication is durably idempotent",
    "concurrent identical cancellation is durably idempotent",
    "concurrent identical terms signature is durably idempotent",
    "publish-concurrent-key01", "cancel-concurrent-key01", "terms-concurrent-key01"
  ]) assert.ok(concurrency.includes(marker), marker);
});
