import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseLock,inspect} from './rust-advisory-graph.mjs';
const sample=[
'[[package]]','name = "gpu_escrow"','version = "0.2.0"','dependencies = [',' "anchor-lang",',']',
'[[package]]','name = "anchor-lang"','version = "0.31.1"','dependencies = [',' "borsh 0.10.4",',' "libsecp256k1",',']',
'[[package]]','name = "borsh"','version = "0.10.4"',
'[[package]]','name = "libsecp256k1"','version = "0.6.0"','dependencies = [',' "rand",',']',
'[[package]]','name = "rand"','version = "0.7.3"',
'[[package]]','name = "gpubnb-host-desktop"','version = "0.1.0"','dependencies = [',' "tauri",',']',
'[[package]]','name = "tauri"','version = "2.11.5"','dependencies = [',' "glib",',']',
'[[package]]','name = "glib"','version = "0.18.5"',''].join('\n');
test('all three known advisories resolve from a workspace root',()=>{
 const r=inspect(parseLock(sample));
 assert.equal(r.length,3);
 for(const x of r){assert.equal(x.status,'BLOCKED');assert.equal(x.path[0].split('@')[0],x.root);assert.equal(x.path.at(-1),x.name+'@'+x.version)}
});
test('reports absence only when pinned versions vanish',()=>{
 const changed=sample.replace('version = "0.7.3"','version = "0.8.6"').replace('version = "0.18.5"','version = "0.20.0"').replace('version = "0.10.4"','version = "1.8.0"').replace('"borsh 0.10.4"','"borsh 1.8.0"');
 assert(inspect(parseLock(changed)).every(x=>x.status==='ABSENT_FROM_LOCK_ONLY'));
});
test('invalid, duplicate and ambiguous graphs fail closed',()=>{
 assert.throws(()=>parseLock(''),/invalid Cargo.lock/);
 assert.throws(()=>parseLock(sample+'[[package]]\nname = "rand"\nversion = "0.7.3"\n'),/duplicate package/);
 assert.throws(()=>parseLock(sample.replace(' "anchor-lang",',' bad,')),/unparseable dependency/);
 assert.throws(()=>inspect(parseLock(sample+'[[package]]\nname = "rand"\nversion = "0.8.6"\n')),/ambiguous or unresolved/);
});
