import test from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeToken } from '../src/security.js';

test('constant-time token comparison accepts exact value',()=>assert.equal(constantTimeToken('secret-value','secret-value'),true));
test('constant-time token comparison rejects missing, short and different values',()=>{
 assert.equal(constantTimeToken(undefined,'secret-value'),false);
 assert.equal(constantTimeToken('secret','secret-value'),false);
 assert.equal(constantTimeToken('secret-valuf','secret-value'),false);
});
