import test from "node:test";
import assert from "node:assert/strict";
import { canonicalBytes, stableStringify } from "../src/canonical.mjs";

test("canonical object sorting follows RFC 8785 UTF-16 ordering", () => {
  const input = {
    "\u20ac": "euro",
    "\r": "carriage-return",
    "\ufb33": "hebrew",
    "1": "one",
    "\ud83d\ude00": "emoji",
    "\u0080": "control",
    "\u00f6": "latin"
  };

  const serialized = stableStringify(input);

  assert.equal(
    serialized,
    '{"\\r":"carriage-return","1":"one","":"control","ö":"latin","€":"euro","😀":"emoji","דּ":"hebrew"}'
  );
});

test("canonical serialization is recursive and preserves array order", () => {
  const value = {
    z: [{ b: 2, a: 1 }, { d: 4, c: 3 }],
    a: true
  };
  assert.equal(
    stableStringify(value),
    '{"a":true,"z":[{"a":1,"b":2},{"c":3,"d":4}]}'
  );
});

test("canonical profile rejects lone Unicode surrogates in values and keys", () => {
  assert.throws(() => stableStringify("\ud800"));
  assert.throws(() => stableStringify("\udc00"));
  assert.throws(() => stableStringify({ ["\ud800"]: "bad" }));
  assert.equal(stableStringify("\ud83d\ude00"), '"😀"');
});

test("canonical profile allows only safe integer JSON numbers", () => {
  assert.equal(stableStringify(0), "0");
  assert.equal(stableStringify(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
  assert.throws(() => stableStringify(1.5));
  assert.throws(() => stableStringify(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => stableStringify(NaN));
  assert.throws(() => stableStringify(Infinity));
});

test("canonical bytes are UTF-8 and deterministic", () => {
  const a = canonicalBytes({ b: "é", a: "😀" });
  const b = canonicalBytes({ a: "😀", b: "é" });
  assert.deepEqual(a, b);
  assert.equal(a.toString("utf8"), '{"a":"😀","b":"é"}');
});
