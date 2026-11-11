import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sandbox = vm.createContext({});
vm.runInContext(readFileSync(new URL('../model.js', import.meta.url), 'utf8'), sandbox);
const { profit, validateFeed } = sandbox.GPUBNBProfitCore;
const params = { grossEur24h: 2, watts: 100, quantity: 1, hours: 24, electricityEurKwh: .2, poolFeePercent: 1 };
const snapshot = (now) => ({ source: 'Licensed mining API', updatedAt: new Date(now).toISOString(), currency: 'EUR', devices: [{ id: 'gpu-one', coins: [{ coin: 'RVN', algorithm: 'KawPow', grossEur24h: 1.2 }] }] });
const known = new Set(['gpu-one']);
const now = Date.parse('2026-11-11T12:00:00.000Z');

test('daily net = gross - fees - electricity, year and month are projections', () => {
  const result = profit(params);
  assert.ok(result);
  assert.ok(Math.abs(result.gross - 2) < 1e-9);
  assert.ok(Math.abs(result.electricity - .48) < 1e-9);
  assert.ok(Math.abs(result.fees - .02) < 1e-9);
  assert.ok(Math.abs(result.net - 1.50) < 1e-9);
  assert.ok(Math.abs(result.net * 30 - 45) < 1e-9);
  assert.ok(Math.abs(result.net * 365 - 547.5) < 1e-9);
});
test('quantity and daily activity multiply both revenue and electricity', () => {
  const r = profit({ ...params, quantity: 3, hours: 12 });
  assert.ok(Math.abs(r.gross - 3) < 1e-9);
  assert.ok(Math.abs(r.electricity - .72) < 1e-9);
  assert.ok(Math.abs(r.kwh - 3.6) < 1e-9);
});
test('zero hours is zero revenue and cost; non-profitable is negative', () => {
  assert.equal(profit({ ...params, hours: 0 }).net, 0);
  assert.ok(profit({ ...params, grossEur24h: 0 }).net < 0);
});
test('invalid fractions, invalid fields and out-of-range parameters are rejected', () => {
  for (const change of [{quantity:1.5},{quantity:0},{quantity:101},{watts:0},{hours:25},{poolFeePercent:-1},{grossEur24h:NaN},{electricityEurKwh:-.01}]) {
    assert.equal(profit({ ...params, ...change }), null);
  }
});
test('accepts a fresh feed only for known devices and finite amounts', () => {
  const d = snapshot(now);
  d.devices.push({id:'unrecognized',coins:[{coin:'RVN',algorithm:'KawPow',grossEur24h:500}]});
  const result = validateFeed(d, known, now);
  assert.ok(result);
  assert.equal(result.map.size, 1);
  assert.equal(result.map.get('gpu-one')[0].gross, 1.2);
});
test('rejects stale, future, empty or malicious feed', () => {
  assert.equal(validateFeed(snapshot(now - 3 * 60 * 60 * 1000), known, now), null);
  assert.equal(validateFeed(snapshot(now + 6 * 60 * 1000), known, now), null);
  assert.equal(validateFeed({ ...snapshot(now), source:'' }, known, now), null);
  assert.equal(validateFeed({ ...snapshot(now), currency:'USD' }, known, now), null);
  assert.equal(validateFeed({ ...snapshot(now), devices:[] }, known, now), null);
  const d = snapshot(now);
  d.devices[0].coins[0].coin = '<script>alert(1)</script>';
  assert.equal(validateFeed(d, known, now), null);
  d.devices[0].coins[0].coin = 'RVN';
  d.devices[0].coins[0].grossEur24h = '2000';
  assert.equal(validateFeed(d, known, now), null);
});
