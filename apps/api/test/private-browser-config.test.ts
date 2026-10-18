import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { registerPrivateBrowserConfig, privateWebSocketCspSource } from '../src/private-browser-config.js';

test('private CSP names exactly the current WSS host and rejects header injection',()=>{
  assert.equal(privateWebSocketCspSource({headers:{host:'gpubnb-stage3-private.onrender.com'}}),'wss://gpubnb-stage3-private.onrender.com');
  for(const host of [undefined,'other.test; *','evil.test/path','evil.test\r\nX-Test: bad']){
    assert.equal(privateWebSocketCspSource({headers:{host}}),"'none'");
  }
});

test('private frontend exposes the same exact deployment SHA and same HTTPS origin as API',async()=>{
  const saved={...process.env};
  const app=Fastify();
  try {
    process.env.GPUBNB_RELEASE_SHA='1234567890abcdef1234567890abcdef12345678';
    registerPrivateBrowserConfig(app,fileURLToPath(new URL('../../web/config.js',import.meta.url)));
    const response=await app.inject('/config.js');assert.equal(response.statusCode,200);
    assert.equal(response.headers['cache-control'],'no-store');
    const window={location:{protocol:'https:',origin:'https://private.invalid'}} as Record<string,any>;
    vm.runInNewContext(response.body,{window});
    assert.equal(window.GPUBNB_BUILD.releaseCommit,process.env.GPUBNB_RELEASE_SHA);
    assert.equal(window.GPUBNB_API_URL,window.location.origin);
    assert.equal(window.GPUBNB_GATEWAY_URL,window.location.origin);
    delete process.env.GPUBNB_RELEASE_SHA;delete process.env.RENDER_GIT_COMMIT;delete process.env.GITHUB_SHA;
    assert.equal((await app.inject('/config.js')).statusCode,503);
  } finally {
    for(const key of ['GPUBNB_RELEASE_SHA','RENDER_GIT_COMMIT','GITHUB_SHA']){
      if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
    }
    await app.close();
  }
});
