// Strict bounded data primitives for offline research, never a signer or executor.
import {createHash} from 'node:crypto';
export function requireThat(condition, message) { if (!condition) throw new Error(message); }
function dataProperties(value, label) {
  requireThat(Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key).enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), `${label}: enumerable data properties required`);
}
export function exactObject(value, keys, label) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), `${label}: plain object required`);
  dataProperties(value, label);
  requireThat(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `${label}: unexpected or missing fields`);
}
export function text(value, pattern, label) { requireThat(typeof value === 'string' && pattern.test(value), `${label}: invalid value`); return value; }
export function uint(value, label, maximum = (1n << 256n) - 1n) {
  text(value, /^(0|[1-9][0-9]{0,77})$/, label);
  requireThat(BigInt(value) <= maximum, `${label}: integer exceeds bound`); return BigInt(value);
}
export function safeTime(value, label) { requireThat(Number.isSafeInteger(value) && value >= 0, `${label}: safe time required`); return value; }
export function digest(value, label) { return text(value, /^[a-f0-9]{64}$/, label); }
export function canonical(value, depth = 0) {
  requireThat(depth <= 16, 'data nesting exceeds bound');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { requireThat(value.length <= 4096, 'string exceeds bound'); return value; }
  if (typeof value === 'number') { requireThat(Number.isSafeInteger(value), 'unsafe JSON number'); return value; }
  if (Array.isArray(value)) {
    requireThat(Object.getPrototypeOf(value) === Array.prototype && value.length <= 128, 'plain bounded array required');
    const keys = Reflect.ownKeys(value);
    requireThat(keys.length === value.length + 1 && keys.every(key =>
      typeof key === 'string' && (key === 'length' || (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length))),
    'sparse array or non-JSON array properties');
    for (let index = 0; index < value.length; index++) {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      requireThat(property && property.enumerable && Object.hasOwn(property, 'value'), 'array indices must be enumerable data properties');
    }
    return value.map(v => canonical(v, depth + 1));
  }
  requireThat(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'non-JSON data');
  dataProperties(value, 'JSON data');
  const keys = Object.keys(value).sort(); requireThat(keys.length <= 64, 'object exceeds bound');
  requireThat(keys.every(k => !['__proto__', 'constructor', 'prototype'].includes(k)), 'unsafe object key');
  return Object.fromEntries(keys.map(k => [k, canonical(value[k], depth + 1)]));
}
export function dataHash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
export function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function offline(value) { return freeze({...value, simulationOnly: true, qualified: false, executableOperations: []}); }
