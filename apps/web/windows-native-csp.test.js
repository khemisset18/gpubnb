import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('native desktop styling works with strict style-src self, no unsafe-inline', () => {
  const html = readFileSync(new URL('./windows-native-desktop.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./windows-native-desktop.css', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="windows-native-desktop\.css">/);
  assert.doesNotMatch(html, /<style(?:\s|>)/iu);
  assert.doesNotMatch(html, /\sstyle\s*=/iu);
  assert.match(css, /canvas\s*\{/u);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/iu);
});

test('gaming player workspace is a browser game surface, not a desktop page', () => {
  const html = readFileSync(new URL('./gaming-workspace.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./gaming-workspace.css', import.meta.url), 'utf8');
  assert.match(html, /<body data-workspace-kind="gaming">/);
  assert.match(html, /Gaming Workspace/u);
  assert.match(html, /id="nativeDesktopCanvas"/u);
  assert.match(html, /id="nativeDesktopStopSession"/u);
  assert.match(html, /vos propres licences/u);
  assert.match(html, /ne sont pas encore pris en charge/u);
  assert.doesNotMatch(html, /Bureau distant|Windows 11|<style(?:\s|>)/iu);
  assert.match(html, /gaming-workspace\.css/u);
  assert.match(css, /\.gaming-player\s*\{/u);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/iu);
});
