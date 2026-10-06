import { invariant } from "./errors.mjs";
export const MAX_ATOMIC_AMOUNT = (1n << 128n) - 1n;
export function parseAtomicAmount(value) {
  invariant(typeof value === "string", "AMOUNT_TYPE", "atomic amount must be a decimal string");
  invariant(/^(0|[1-9][0-9]*)$/.test(value), "AMOUNT_FORMAT", "atomic amount must use canonical unsigned decimal form");
  const amount = BigInt(value);
  invariant(amount <= MAX_ATOMIC_AMOUNT, "AMOUNT_RANGE", "atomic amount exceeds u128 range");
  return amount;
}
export function atomicAmountToString(amount) {
  invariant(typeof amount === "bigint", "AMOUNT_TYPE", "atomic amount must be bigint");
  invariant(amount >= 0n && amount <= MAX_ATOMIC_AMOUNT, "AMOUNT_RANGE", "atomic amount out of range");
  return amount.toString(10);
}
export function checkedAdd(a, b) {
  invariant(typeof a === "bigint" && typeof b === "bigint", "AMOUNT_TYPE", "amounts must be bigint");
  const result = a + b;
  invariant(result >= 0n && result <= MAX_ATOMIC_AMOUNT, "AMOUNT_OVERFLOW", "atomic amount overflow");
  return result;
}
