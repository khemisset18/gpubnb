import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkedDecimalToKoinu, assertNativeIsolation } from './native-regtest.mjs';

test('exact integer koinu units and 8 decimals for native coinbase observations',()=>{
  for(const [coin,expected] of [[5,500000000n],[0.01,1000000n],[42.12345678,4212345678n],[10000,1000000000000n]])
    assert.equal(checkedDecimalToKoinu(coin),expected);
});
test('rejects malformed, zero, negative or unrealistic native coinbase outputs',()=>{
  for(const value of [0,-1,Infinity,NaN,'5',null,1e12]) assert.throws(()=>checkedDecimalToKoinu(value));
});
test('refuses any native operation absent explicit exact-scope grant',()=>{
  assert.throws(()=>assertNativeIsolation({}),/exact-scope/);
  assert.throws(()=>assertNativeIsolation({AE_D2_NATIVE_SCOPE:'AUTHORIZE_D2_SCRIPT_DIAGNOSTICS'}),/exact-scope/);
});
test('refuses to run in parent network namespace even with valid scope',()=>{
  const parent=execFileSync('readlink',['/proc/self/ns/net'],{encoding:'utf8'}).trim();
  assert.throws(()=>assertNativeIsolation({AE_D2_NATIVE_SCOPE:'AUTHORIZE_DOGE_D2_SYNTHETIC_SIGNING_AND_PRIVATE_REGTEST_ONLY',
    AE_D0_VERIFIED_ARCHIVE_SHA256:'4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8',
    AE_PARENT_NET_NS:parent}),/parent network namespace/);
});
test('running the native runner directly fails closed and never starts a node',()=>{
  const p=spawnSync(process.execPath,[new URL('./native-regtest.mjs',import.meta.url).pathname],{encoding:'utf8',timeout:2000});
  assert.equal(p.status,2);
  assert.match(p.stderr,/exact-scope authorization/);
});
