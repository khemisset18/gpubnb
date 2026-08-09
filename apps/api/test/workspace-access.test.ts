import test from 'node:test';
import assert from 'node:assert/strict';
import { issueWorkspaceAccessGrant,consumeWorkspaceAccessGrant } from '../src/workspace-access.js';

class FakeRedis{
  values=new Map<string,string>();
  async set(key:string,value:string,_ex:string,_ttl:number,_nx:string){if(this.values.has(key))return null;this.values.set(key,value);return 'OK';}
  async getdel(key:string){const value=this.values.get(key)??null;this.values.delete(key);return value;}
}

test('workspace access grant is opaque, scoped and one-time',async()=>{
  const redis=new FakeRedis();
  const grant=await issueWorkspaceAccessGrant(redis as never,{userId:'renter-1',bookingId:'booking-1',sessionId:'session-1'});
  assert.ok(grant.token.length>=40);
  assert.equal(grant.expiresIn,60);
  assert.equal([...redis.values.values()][0]?.includes(grant.token),false);
  const consumed=await consumeWorkspaceAccessGrant(redis as never,grant.token);
  assert.equal(consumed?.userId,'renter-1');
  assert.equal(consumed?.bookingId,'booking-1');
  assert.equal(consumed?.sessionId,'session-1');
  assert.equal(await consumeWorkspaceAccessGrant(redis as never,grant.token),null);
});

test('invalid oversized token is rejected without lookup',async()=>{
  const redis=new FakeRedis();
  assert.equal(await consumeWorkspaceAccessGrant(redis as never,'x'.repeat(129)),null);
});
