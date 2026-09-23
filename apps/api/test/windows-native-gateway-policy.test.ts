import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceRuntimeBackend } from '@prisma/client';
import {
  WINDOWS_NATIVE_BROWSER_INPUT_BYTES,
  browserGatewayFrameAllowed,
  gatewayRuntimeBackends,
  isWindowsNativeRuntime,
  upstreamGatewayFrameAllowed,
  windowsNativeUpgradeAllowed,
} from '../src/windows-native-gateway-policy.js';

test('gateway supports native transport without replacing the container backend', () => {
  assert.deepEqual(
    gatewayRuntimeBackends(),
    [WorkspaceRuntimeBackend.CONTAINER, WorkspaceRuntimeBackend.WINDOWS_NATIVE],
  );
  assert.equal(isWindowsNativeRuntime(WorkspaceRuntimeBackend.WINDOWS_NATIVE), true);
  assert.equal(isWindowsNativeRuntime(WorkspaceRuntimeBackend.CONTAINER), false);
});

test('native browser upgrades are pinned to one query-free stream path', () => {
  assert.equal(
    windowsNativeUpgradeAllowed(WorkspaceRuntimeBackend.WINDOWS_NATIVE, 'native-stream', ''),
    true,
  );
  for (const [suffix, search] of [
    ['', ''],
    ['native-stream/', ''],
    ['other', ''],
    ['native-stream', '?token=secret'],
    ['native-stream', '?x=1'],
  ]) {
    assert.equal(
      windowsNativeUpgradeAllowed(WorkspaceRuntimeBackend.WINDOWS_NATIVE, suffix, search),
      false,
    );
  }
  assert.equal(
    windowsNativeUpgradeAllowed(WorkspaceRuntimeBackend.CONTAINER, 'arbitrary/code-server/path', '?x=1'),
    true,
  );
});

test('native browser input is binary and exactly the fixed protocol size', () => {
  assert.equal(WINDOWS_NATIVE_BROWSER_INPUT_BYTES, 32);
  assert.equal(
    browserGatewayFrameAllowed(WorkspaceRuntimeBackend.WINDOWS_NATIVE, true, 32),
    true,
  );
  assert.equal(
    browserGatewayFrameAllowed(WorkspaceRuntimeBackend.WINDOWS_NATIVE, false, 32),
    false,
  );
  assert.equal(
    browserGatewayFrameAllowed(WorkspaceRuntimeBackend.WINDOWS_NATIVE, true, 31),
    false,
  );
  assert.equal(
    browserGatewayFrameAllowed(WorkspaceRuntimeBackend.WINDOWS_NATIVE, true, 33),
    false,
  );
  assert.equal(
    browserGatewayFrameAllowed(WorkspaceRuntimeBackend.CONTAINER, false, 2048),
    true,
  );
});

test('native upstream media must be binary while close remains transport metadata', () => {
  assert.equal(
    upstreamGatewayFrameAllowed(WorkspaceRuntimeBackend.WINDOWS_NATIVE, true, false),
    true,
  );
  assert.equal(
    upstreamGatewayFrameAllowed(WorkspaceRuntimeBackend.WINDOWS_NATIVE, false, false),
    false,
  );
  assert.equal(
    upstreamGatewayFrameAllowed(WorkspaceRuntimeBackend.WINDOWS_NATIVE, false, true),
    true,
  );
  assert.equal(
    upstreamGatewayFrameAllowed(WorkspaceRuntimeBackend.CONTAINER, false, false),
    true,
  );
});
