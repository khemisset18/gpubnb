import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const hookPath = path.join(
  repoRoot,
  'apps/host-desktop/src-tauri/windows/installer-hooks.nsh',
);

const source = fs.readFileSync(hookPath, 'utf8');

const compact = source.replace(/\s+/g, ' ');

test('installer creates and secures ProgramData GPUbnb before service install', () => {
  const createIndex = source.indexOf('CreateDirectory "$%PROGRAMDATA%\\GPUbnb"');
  const aclIndex = source.indexOf('[System.IO.Directory]::SetAccessControl');
  const serviceIndex = source.indexOf('gpubnb-agent.exe\" service install');
  assert.ok(createIndex >= 0, 'shared GPUbnb data directory must be explicit');
  assert.ok(aclIndex > createIndex, 'ACL hardening must happen after directory creation');
  assert.ok(serviceIndex > aclIndex, 'service may start only after the data directory is protected');
});

test('ordinary uninstall never deletes owner identity or configuration', () => {
  const forbidden = [
    /RMDir\s+\/r\s+"\$%PROGRAMDATA%\\GPUbnb"/i,
    /Delete\s+"\$%PROGRAMDATA%\\GPUbnb\\agent\.key"/i,
    /Delete\s+"\$%PROGRAMDATA%\\GPUbnb\\config\.json"/i,
    /Remove-Item[^\r\n]*ProgramData[^\r\n]*GPUbnb/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern);
  }
});

test('upgrade stops/replaces service but never clears persistent Host state', () => {
  assert.match(source, /NSIS_HOOK_PREINSTALL/);
  assert.match(source, /sc\.exe\" stop GPUbnbAgent/);
  assert.match(source, /sc\.exe\" delete GPUbnbAgent/);
  assert.doesNotMatch(compact, /PREINSTALL.*(?:agent\.key|config\.json).*Delete/i);
});

test('uninstall removes the service while persistent data deletion remains a separate explicit action', () => {
  const start = source.indexOf('!macro NSIS_HOOK_PREUNINSTALL');
  assert.ok(start >= 0);
  const uninstallHook = source.slice(start);
  assert.match(uninstallHook, /service remove/);
  assert.doesNotMatch(uninstallHook, /PROGRAMDATA%\\GPUbnb\\(?:agent\.key|config\.json)/i);
});

test('installer never changes the owner Windows power plan', () => {
  assert.doesNotMatch(source, /powercfg/i);
});
