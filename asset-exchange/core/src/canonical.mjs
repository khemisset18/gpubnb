import { invariant } from "./errors.mjs";

function assertWellFormedUnicode(value, field = "string") {
  invariant(typeof value === "string", "CANONICAL_STRING", `${field} must be a string`);

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      invariant(i + 1 < value.length, "CANONICAL_UNICODE", `${field} contains lone high surrogate`);
      const next = value.charCodeAt(i + 1);
      invariant(next >= 0xdc00 && next <= 0xdfff, "CANONICAL_UNICODE", `${field} contains invalid surrogate pair`);
      i += 1;
      continue;
    }

    invariant(
      !(code >= 0xdc00 && code <= 0xdfff),
      "CANONICAL_UNICODE",
      `${field} contains lone low surrogate`
    );
  }

  return value;
}

export function stableStringify(value) {
  if (value === null) return "null";

  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "number") {
    invariant(
      Number.isSafeInteger(value),
      "CANONICAL_NUMBER",
      "only safe integers are allowed in canonical JSON"
    );
    return String(value);
  }

  if (typeof value === "bigint") {
    throw new TypeError("bigint must be converted to canonical decimal string before serialization");
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  invariant(typeof value === "object", "CANONICAL_TYPE", "unsupported canonical value");

  const keys = Object.keys(value);
  for (const key of keys) assertWellFormedUnicode(key, "object key");

  // ECMAScript default string ordering compares UTF-16 code units, which is
  // the property-order rule required by RFC 8785/JCS.
  keys.sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function canonicalBytes(value) {
  return Buffer.from(stableStringify(value), "utf8");
}
