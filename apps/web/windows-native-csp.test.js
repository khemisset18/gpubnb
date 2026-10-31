import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('native desktop styling works with strict style-src self, no unsafe-inline', () => {
  const html = readFileSync(new URL('./windows-native-desktop.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./windows-native-desktop.css', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="windows-native-desktop\.css">/);
  assert.doesNotMatch(html, /<style(?:\\s|>)/iu);
  assert.doesNotMatch(html, /\\sstyle\\s*=/iu);
  assert.match(css, /canvas\\s*\\{/u);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/iu);
});
