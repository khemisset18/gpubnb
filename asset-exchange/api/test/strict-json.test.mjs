import test from "node:test";
import assert from "node:assert/strict";
import { parseStrictJson } from "../src/strict-json.mjs";

test("strict JSON rejects duplicate keys at any object depth", () => {
  assert.throws(() => parseStrictJson('{"offer":{"a":1,"a":2}}'));
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'));
});

test("strict JSON accepts escaped strings and arrays", () => {
  assert.deepEqual(parseStrictJson('{"a":"x\\\"y","b":[1,true,null]}'), { a: 'x"y', b: [1, true, null] });
});

test("strict JSON rejects trailing data", () => {
  assert.throws(() => parseStrictJson('{"a":1} {"b":2}'));
});

test("deep JSON is rejected with a bounded parser error before stack exhaustion", () => {
  for (const text of ["[".repeat(12000) + "0" + "]".repeat(12000), '{"a":'.repeat(4000) + '0' + '}'.repeat(4000)]) {
    assert.throws(() => parseStrictJson(text), error => error.code === "JSON_DEPTH");
  }
});

test("JSON depth boundary accepts 32 containers and rejects 33", () => {
  assert.doesNotThrow(() => parseStrictJson("[".repeat(32) + "0" + "]".repeat(32)));
  assert.throws(() => parseStrictJson("[".repeat(33) + "0" + "]".repeat(33)), error => error.code === "JSON_DEPTH");
});

test("direct parser input is bounded before parsing", () => {
  assert.throws(() => parseStrictJson('"' + 'x'.repeat(1024 * 1024) + '"'), error => error.code === "JSON_SIZE");
  assert.throws(() => parseStrictJson('"' + 'é'.repeat(524288) + '"'), error => error.code === "JSON_SIZE");
});
