import test from 'node:test';
import assert from 'node:assert/strict';
import {readBoundedJson,MAX_JSON_BYTES} from '../edge/public-sources.mjs';

const jsonResponse=(value)=>new Response(JSON.stringify(value),{
 headers:{'Content-Type':'application/json'}});
test('small valid public JSON passes as a UTF-8 stream',async()=>{
 const response=jsonResponse({coin:'ETC',rate:123});
 assert.deepEqual(await readBoundedJson(response),{coin:'ETC',rate:123});
});
test('rejects forged size metadata and invalid JSON',async()=>{
 const res=new Response('{"ok":true}',{headers:{'Content-Length':String(MAX_JSON_BYTES+1)}});
 await assert.rejects(readBoundedJson(res),/limit/);
 await assert.rejects(readBoundedJson(new Response('not json'))); 
});
test('rejects unadvertised oversized streamed response before accepting it',async()=>{
 const stream=new ReadableStream({
   start(controller){
     controller.enqueue(new Uint8Array(MAX_JSON_BYTES-40));
     controller.enqueue(new Uint8Array(80));
     controller.close();
   }
 });
 await assert.rejects(readBoundedJson(new Response(stream)),/limit/);
});
test('rejects multibyte UTF-8 bodies exceeding the byte limit, not only chars',async()=>{
 const tooLarge='é'.repeat(MAX_JSON_BYTES/2+1);
 await assert.rejects(readBoundedJson(new Response(JSON.stringify({value:tooLarge}))),/limit/);
});
test('maximum permitted response size cannot be raised by a provider',async()=>{
 await assert.rejects(readBoundedJson(jsonResponse({ok:true}),MAX_JSON_BYTES+1));
 await assert.rejects(readBoundedJson(jsonResponse({ok:true}),0));
});
