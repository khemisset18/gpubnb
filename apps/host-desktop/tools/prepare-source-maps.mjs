// Explicit build-time compatibility patch; see source-map-compat.patch and LICENSE.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync, writeFileSync, lstatSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('./source-map-compat.json', import.meta.url), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function patchConsumer(source) {
  if (sha256(source) === manifest.patchedSha256) return source;
  if (sha256(source) !== manifest.originalSha256) throw new Error('Unrecognized source-map-js source; review the dependency before patching');
  const boundary = 'function IndexedSourceMapConsumer(aSourceMap, aSourceMapURL) {';
  const start = source.indexOf(boundary);
  let tail = source.slice(start);
  for (const {before, after} of manifest.replacements) {
    if (tail.split(before).length !== 2) throw new Error('Compatibility patch preimage is not unique');
    tail = tail.replace(before, after);
  }
  const patched = source.slice(0, start) + tail;
  if (sha256(patched) !== manifest.patchedSha256) throw new Error('Compatibility patch digest mismatch');
  return patched;
}

export function prepare(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const require = createRequire(resolve(root, 'package.json'));
  const packageFile = require.resolve('source-map-js/package.json');
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  if (pkg.version !== manifest.version) throw new Error('Unexpected source-map-js version');
  const target = resolve(dirname(packageFile), manifest.file);
  if (!lstatSync(target).isFile()) throw new Error('Source-map consumer must be a regular file');
  const original = readFileSync(target, 'utf8');
  const patched = patchConsumer(original);
  if (patched !== original) writeFileSync(target, patched, 'utf8');
  return {package: pkg.name, version: pkg.version, compatibilityPatch: 'indexed-maps-v1', sha256: sha256(readFileSync(target))};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(prepare()));
