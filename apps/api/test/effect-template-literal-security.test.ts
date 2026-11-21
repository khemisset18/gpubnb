import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadConfigFromFile } from '@prisma/config';
import * as Schema from 'effect/Schema';

test('Effect rejects the advisory template-literal input inside a bounded child', { timeout: 12_000 }, () => {
  // GHSA-7589-6fvf-x4pw: exercise the real decoder without letting the
  // vulnerable implementation block this test runner's event loop.
  const child = spawnSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import * as Schema from 'effect/Schema';
    const schema = Schema.TemplateLiteral(Schema.String, ':', Schema.String, ':', Schema.String, 'X');
    const is = Schema.is(schema);
    const decode = Schema.decodeUnknownSync(schema);
    const checked = [];
    for (const length of [5000, 100000]) {
      const input = ':'.repeat(length);
      assert.equal(is(input), false);
      assert.throws(() => decode(input));
      checked.push(length);
    }
    console.log(JSON.stringify({ rejectedLengths: checked }));
  `], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, 'template decoder exceeded its process bound');
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { rejectedLengths: [5000, 100000] });
});

test('Effect string-span matching preserves literal separators, newlines and exact suffixes', () => {
  const schema = Schema.TemplateLiteral('[', Schema.String, '.*', Schema.String, ']');
  const is = Schema.is(schema);
  const decode = Schema.decodeUnknownSync(schema);
  for (const input of ['[.*]', '[left.*right]', '[\n.*\n]', '[é.*🐕]', '[a.*b.*c]']) {
    assert.equal(is(input), true, input);
    assert.equal(decode(input), input);
  }
  for (const input of ['left.*right]', '[left.*right', '[leftXright]', '[.*]trailing', 1, null]) {
    assert.equal(is(input), false);
    assert.throws(() => decode(input));
  }
});

test('Prisma config retains valid path loading and rejects malformed or excess terms with patched Effect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gpubnb-prisma-effect-'));
  try {
    const validPath = join(directory, 'valid.config.mjs');
    writeFileSync(validPath, 'export default ' + JSON.stringify({
      schema: 'prisma/schema.prisma', migrations: { path: 'prisma/migrations' }
    }));
    const valid = await loadConfigFromFile({ configFile: validPath, configRoot: directory });
    assert.equal(valid.error, undefined);
    assert.ok(valid.config);
    assert.equal(valid.config.schema, join(directory, 'prisma/schema.prisma'));
    assert.equal(valid.config.migrations?.path, join(directory, 'prisma/migrations'));
    for (const [index, input] of [{ schema: 42 }, { schema: 'schema.prisma', unexpected: true }].entries()) {
      const invalidPath = join(directory, `invalid-${index}.config.mjs`);
      writeFileSync(invalidPath, 'export default ' + JSON.stringify(input));
      const invalid = await loadConfigFromFile({ configFile: invalidPath, configRoot: directory });
      assert.equal(invalid.error?._tag, 'ConfigFileSyntaxError');
      assert.equal(invalid.config, undefined);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
