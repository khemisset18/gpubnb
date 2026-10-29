// Offline candidate-only dependency check; no desktop/native process or server.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {Worker} from 'node:worker_threads';
const root = resolve(process.argv[2] ?? 'MISSING_CANDIDATE_ROOT');
const require = createRequire(resolve(root, 'package.json'));
const modulePath = require.resolve('source-map-js');
const worker = new Worker(`
  const {parentPort, workerData} = require('node:worker_threads');
  const assert = require('node:assert/strict');
  const {SourceMapConsumer, SourceMapGenerator} = require(workerData);
  const leaf = {version: 3, sources: ['fixture.ts'], names: [], mappings: 'AAAA'};
  const indexed = (line, map = leaf) => ({version: 3, sections: [{offset: {line, column: 0}, map}]});
  for (const bad of [-1, 1.5, NaN, Infinity, 1e15]) {
    assert.throws(() => new SourceMapConsumer(indexed(bad)), /offset/i);
  }
  assert.throws(() => new SourceMapConsumer(indexed(6000000, indexed(6000000))), /offset/i);
  parentPort.postMessage({stage: 'malformed-offset-rejection', status: 'PASS', cases: 6});
  const valid = new SourceMapConsumer(indexed(3));
  assert.equal(valid.originalPositionFor({line: 4, column: 0}).source, 'fixture.ts');
  assert.ok(SourceMapGenerator.fromSourceMap(valid).toString().includes('fixture.ts'));
  parentPort.postMessage({status: 'PASS', malformedCases: 6, validRoundTrip: true});
`, {eval: true, workerData: modulePath});
const stages = [];
try {
const result = await new Promise((resolveResult, reject) => {
  const timeout = setTimeout(() => { worker.terminate(); reject(new Error('source-map check exceeded 3 seconds')); }, 3000);
  worker.on('message', value => { if (value.stage) stages.push(value); else {clearTimeout(timeout); resolveResult(value);} });
  worker.once('error', error => {clearTimeout(timeout); reject(error);});
  worker.once('exit', code => {if (code !== 0) {clearTimeout(timeout); reject(new Error('worker exit ' + code));}});
});
assert.equal(result.status, 'PASS');
console.log(JSON.stringify({...result, stages}));
} catch (error) {
  console.log(JSON.stringify({status: 'FAILED_FUNCTIONAL_EXPECTATION', stages, error: error.message}));
  process.exitCode = 1;
}
