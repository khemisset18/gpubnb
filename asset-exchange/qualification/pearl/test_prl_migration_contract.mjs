import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const file = new URL("../../db/migrations/010_prl_historical_offer_quarantine.sql", import.meta.url);
const sql = readFileSync(file, "utf8");

// STATIC CONTRACT ONLY: These tests do NOT execute SQL or prove that a
// PostgreSQL instance enforces the triggers. A disposable DB review is needed.
test("migration is an additive transaction, not an executed migration", () => {
  assert.match(sql, /^-- GPUbnb Asset Exchange/);
  assert.match(sql, /\bBEGIN;\s*SET LOCAL search_path/);
  assert.match(sql, /\bCOMMIT;\s*$/);
});
test("migration defines an explicit shared rejector for PRL chain aliases", () => {
  assert.match(sql, /CREATE FUNCTION asset_exchange\.reject_unqualified_prl_asset_keys/);
  assert.match(sql, /v_chain IN \('pearl', 'prl'\)/);
  assert.match(sql, /USING ERRCODE = '55000'/);
});
test("offers INSERT trigger prohibits direct SQL PRL publication", () => {
  assert.match(sql, /CREATE TRIGGER offers_reject_unqualified_prl_insert/);
  assert.match(sql, /BEFORE INSERT ON asset_exchange\.offers/);
  assert.match(sql, /NEW\.give_asset_key, NEW\.want_asset_key/);
});
test("trade INSERT trigger reads stored offer assets, not caller terms", () => {
  assert.match(sql, /CREATE TRIGGER trades_reject_unqualified_prl_insert/);
  assert.match(sql, /BEFORE INSERT ON asset_exchange\.trades/);
  assert.match(sql, /SELECT o\.give_asset_key, o\.want_asset_key/);
  assert.match(sql, /WHERE o\.offer_id = NEW\.offer_id/);
  assert.match(sql, /AND o\.deployment_id = NEW\.deployment_id/);
});
test("consumption trigger covers direct update paths", () => {
  assert.match(sql, /CREATE TRIGGER offers_reject_unqualified_prl_consumption/);
  assert.match(sql, /BEFORE UPDATE OF state, accepted_trade_id ON asset_exchange\.offers/);
  assert.match(sql, /NEW\.state = 'CONSUMED'/);
  assert.match(sql, /OLD\.give_asset_key, OLD\.want_asset_key/);
});
test("no trigger disables existing audit or financial immutability controls", () => {
  assert.doesNotMatch(sql, /DROP\s+(TABLE|TRIGGER|FUNCTION)/i);
  assert.doesNotMatch(sql, /DISABLE\s+TRIGGER/i);
  assert.doesNotMatch(sql, /SECURITY\s+DEFINER/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM/i);
  assert.doesNotMatch(sql, /UPDATE\s+asset_exchange\.operator_state/i);
});
