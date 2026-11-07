import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parseStrictJson, readBody } from "../src/strict-json.mjs";

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

test("JSON rejects overflowing finite number representation", () => {
  assert.throws(() => parseStrictJson('{"amount":1e100000}'), { code: "JSON_NUMBER_RANGE" });
  assert.throws(() => parseStrictJson("[-1e999,2]"), { code: "JSON_NUMBER_RANGE" });
  assert.deepEqual(parseStrictJson("[1.25,1e3,-2]"), [1.25,1000,-2]);
});

test("JSON rejects more than 16384 value nodes before materializing a large tree", () => {
  const text = "[" + "0,".repeat(16_384) + "0]";
  assert.throws(() => parseStrictJson(text), { code: "JSON_NODES" });
});

test("JSON body rejects invalid UTF-8 rather than replacing malformed bytes", async () => {
  const malformed = Readable.from([Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d])]);
  await assert.rejects(readBody(malformed), { code: "JSON_UTF8" });
});

test("JSON body accepts valid UTF-8 split across network chunks", async () => {
  const original = '{"amount":"€"}';
  const bytes = Buffer.from(original, "utf8");
  const mark = bytes.indexOf(0xe2);
  const stream = Readable.from([bytes.subarray(0, mark + 1), bytes.subarray(mark + 1)]);
  assert.equal(await readBody(stream), original);
});

test("JSON rejects non-RFC whitespace and preserves bounded normal arrays", () => {
  assert.throws(() => parseStrictJson("[1,\u00a02]"));
  assert.equal(parseStrictJson("[" + "0,".repeat(10_000) + "0]").length, 10_001);
});
