import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {patchConsumer, prepare} from '../tools/prepare-source-maps.mjs';

const require = createRequire(import.meta.url);
const {SourceMapConsumer, SourceMapGenerator} = require('source-map-js');
const postcss = require('postcss');
const leaf = {version: 3, sources: ['fixture.ts'], sourcesContent: ['const value = 1;'], names: ['value'], mappings: 'AAAAA;AACA'};
const indexed = (line, column = 0, map = leaf) => ({version: 3, sections: [{offset: {line, column}, map}]});

test('patch is deterministic, idempotent and refuses unknown dependency bytes', () => {
  const consumer = readFileSync(require.resolve('source-map-js/lib/source-map-consumer.js'), 'utf8');
  assert.equal(patchConsumer(consumer), consumer);
  assert.deepEqual(prepare(), prepare());
  assert.throws(() => patchConsumer(consumer + '\n'), /Unrecognized/);
});

test('exact original indexed-column-zero and flattening diagnostic now succeeds', () => {
  const consumer = new SourceMapConsumer(indexed(3, 0, {version: 3, sources: ['fixture.ts'], names: [], mappings: 'AAAA'}));
  assert.equal(consumer.originalPositionFor({line: 4, column: 0}).source, 'fixture.ts');
  const flat = new SourceMapConsumer(SourceMapGenerator.fromSourceMap(consumer).toString());
  assert.equal(flat.originalPositionFor({line: 4, column: 0}).source, 'fixture.ts');
  assert.equal(consumer.sourceContentFor('fixture.ts'), null);
  assert.throws(() => consumer.sourceContentFor('absent.ts'), /not in the SourceMap/);
});

test('section offset affects only its first local line and preserves name index zero', () => {
  const consumer = new SourceMapConsumer(indexed(3, 7));
  assert.equal(consumer.originalPositionFor({line: 4, column: 6}).source, null);
  assert.equal(consumer.originalPositionFor({line: 4, column: 7}).name, 'value');
  assert.deepEqual(consumer.generatedPositionFor({source: 'fixture.ts', line: 1, column: 0}), {line: 4, column: 7});
  assert.deepEqual(consumer.generatedPositionFor({source: 'fixture.ts', line: 2, column: 0}), {line: 5, column: 0});
  const flat = new SourceMapConsumer(SourceMapGenerator.fromSourceMap(consumer).toString());
  assert.equal(flat.originalPositionFor({line: 5, column: 0}).line, 2);
  assert.equal(flat.originalPositionFor({line: 4, column: 7}).name, 'value');
});

test('nested sections preserve reverse positions, contents and multi-position lookup', () => {
  const consumer = new SourceMapConsumer(indexed(3, 4, indexed(2, 5)));
  assert.equal(consumer.originalPositionFor({line: 6, column: 5}).source, 'fixture.ts');
  assert.deepEqual(consumer.generatedPositionFor({source: 'fixture.ts', line: 1, column: 0}), {line: 6, column: 5});
  assert.deepEqual(consumer.generatedPositionFor({source: 'absent.ts', line: 1, column: 0}), {line: null, column: null});
  assert.equal(consumer.sourceContentFor('fixture.ts'), leaf.sourcesContent[0]);
  assert.deepEqual(consumer.allGeneratedPositionsFor({source: 'fixture.ts', line: 1, column: 0}), [{line: 6, column: 5, lastColumn: null}]);
});

test('unmapped segments stay unmapped after flattening; flat consumers remain compatible', () => {
  const map = {...leaf, mappings: 'AAAAA,C'};
  const flattened = new SourceMapConsumer(SourceMapGenerator.fromSourceMap(new SourceMapConsumer(indexed(3, 2, map))).toString());
  assert.equal(flattened.originalPositionFor({line: 4, column: 3}).source, null);
  const flat = new SourceMapConsumer(leaf);
  assert.equal(flat.originalPositionFor({line: 1, column: 0}).name, 'value');
});

test('PostCSS consumes actual indexed previous maps without losing the source', async () => {
  const css = 'a { color: red }';
  const map = indexed(0, 0, {version: 3, sources: ['input.scss'], sourcesContent: [css], names: [], mappings: 'AAAA'});
  const result = await postcss([]).process(css, {from: 'input.css', to: 'output.css', map: {prev: map, inline: false, annotation: false}});
  assert.ok(result.map.toJSON().sources.some(source => source.endsWith('input.scss')));
  assert.equal(new SourceMapConsumer(result.map.toJSON()).originalPositionFor({line: 1, column: 0}).source, 'input.scss');
});

test('malformed/extreme/nested offsets still fail within a bounded worker', {timeout: 5000}, async () => {
  const worker = new Worker(`
    const {parentPort, workerData} = require('node:worker_threads');
    const assert = require('node:assert/strict');
    const {SourceMapConsumer} = require(workerData);
    const leaf = {version:3,sources:['fixture.ts'],names:[],mappings:'AAAA'};
    const indexed = (line, column=0, map=leaf) => ({version:3, sections:[{offset:{line,column},map}]});
    for (const bad of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER + 1,'1']) {
      assert.throws(() => new SourceMapConsumer(indexed(bad)), /offset/i);
      assert.throws(() => new SourceMapConsumer(indexed(0,bad)), /offset/i);
    }
    assert.throws(() => new SourceMapConsumer(indexed(1e15)), /offset/i);
    assert.throws(() => new SourceMapConsumer(indexed(6000000,0,indexed(6000000))), /offset/i);
    parentPort.postMessage(14);
  `, {eval: true, workerData: require.resolve('source-map-js')});
  try {
    const count = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Source-map worker exceeded three seconds')), 3000);
      worker.once('message', value => {clearTimeout(timer); resolve(value);});
      worker.once('error', error => {clearTimeout(timer); reject(error);});
      worker.once('exit', code => {if(code !== 0) {clearTimeout(timer); reject(new Error('Worker exit ' + code));}});
    });
    assert.equal(count, 14);
  } finally {await worker.terminate();}
});
