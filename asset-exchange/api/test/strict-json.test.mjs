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
