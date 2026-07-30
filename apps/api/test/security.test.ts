import test from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeToken, isTrustedBrowserOrigin } from '../src/security.js';

test('constant-time token comparison accepts exact value',()=>assert.equal(constantTimeToken('secret-value','secret-value'),true));
test('constant-time token comparison rejects missing, short and different values',()=>{
 assert.equal(constantTimeToken(undefined,'secret-value'),false);
 assert.equal(constantTimeToken('secret','secret-value'),false);
 assert.equal(constantTimeToken('secret-valuf','secret-value'),false);
});

test('trusts production and numbered GPUbnb Netlify previews only',()=>{
 assert.equal(isTrustedBrowserOrigin('https://gpubnb.netlify.app','gpubnb.netlify.app'),true);
 assert.equal(isTrustedBrowserOrigin('https://deploy-preview-36--gpubnb.netlify.app','gpubnb.netlify.app'),true);
 assert.equal(isTrustedBrowserOrigin('https://deploy-preview-1--gpubnb.netlify.app','gpubnb.netlify.app'),true);
 assert.equal(isTrustedBrowserOrigin('https://deploy-preview-0--gpubnb.netlify.app','gpubnb.netlify.app'),false);
 assert.equal(isTrustedBrowserOrigin('https://deploy-preview-36--gpubnb.netlify.app.evil.test','gpubnb.netlify.app'),false);
 assert.equal(isTrustedBrowserOrigin('http://deploy-preview-36--gpubnb.netlify.app','gpubnb.netlify.app'),false);
 assert.equal(isTrustedBrowserOrigin('https://random--gpubnb.netlify.app','gpubnb.netlify.app'),false);
});
