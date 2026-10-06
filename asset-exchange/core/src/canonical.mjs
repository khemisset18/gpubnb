import { invariant } from "./errors.mjs";
export function stableStringify(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    invariant(Number.isSafeInteger(value), "CANONICAL_NUMBER", "only safe integers are allowed in canonical JSON");
    return String(value);
  }
  if (typeof value === "bigint") throw new TypeError("bigint must be converted to canonical decimal string before serialization");
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  invariant(typeof value === "object", "CANONICAL_TYPE", "unsupported canonical value");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
export function canonicalBytes(value) {
  return Buffer.from(stableStringify(value), "utf8");
}
