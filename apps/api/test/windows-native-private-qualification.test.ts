import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const desktop = fs.readFileSync(
  new URL('../src/desktop-workspace-routes.ts', import.meta.url),
  'utf8',
);

const catalogue = fs.readFileSync(
  new URL('../src/machine-workspace-catalog.ts', import.meta.url),
  'utf8',
);

const authority = fs.readFileSync(
  new URL('../src/rental-resource-authority.ts', import.meta.url),
  'utf8',
);

test('Windows-native Stage 3 qualification remains private and explicit', () => {
  assert.match(desktop, /qualification === 'windows-native'/);
  assert.match(desktop, /config\.BETA_TEST_DEV_BYPASS === 'true'/);
  assert.match(desktop, /config\.ESCROW_PROGRAM_ID === 'NOT_DEPLOYED_YET'/);
  assert.match(desktop, /WorkspaceRuntimeBackend\.WINDOWS_NATIVE/);
  assert.match(desktop, /status: WorkspaceSessionStatus\.READY/);
  assert.match(desktop, /isolationType: 'WINDOWS_NATIVE'/);
  assert.match(desktop, /runBookingTransaction\(db, async \(tx\) =>/);
});

test('private qualification accepts only non-public listing states', () => {
  assert.match(
    desktop,
    /windowsNativePrivateQualificationListingStatuses:[\s\S]*ListingStatus\.HIDDEN_OFFLINE[\s\S]*ListingStatus\.PAUSED/,
  );
  assert.doesNotMatch(
    desktop,
    /windowsNativePrivateQualificationListingStatuses:[\s\S]{0,200}ListingStatus\.ACTIVE/,
  );
  assert.match(
    desktop,
    /status: \{ in: windowsNativePrivateQualificationListingStatuses \}/,
  );
});

test('qualification requires current native Host proof and exact allocated GPU UUID', () => {
  assert.match(desktop, /nativeDesktopStreamingAvailable === true/);
  assert.match(desktop, /nativeDesktopStreamingGpuUuid/);
  assert.match(desktop, /WINDOWS_NATIVE_GPU_UUID_RE/);
  assert.match(desktop, /allocations\.length !== 1/);
  assert.match(desktop, /accelerator\.hardwareUuid\.toLowerCase\(\) !== nativeGpuUuid\.toLowerCase\(\)/);
  assert.match(desktop, /windows_native_qualification_other_live_workspace/);
  assert.match(desktop, /ListingResourceMode\.FULL_MACHINE/);
  assert.match(desktop, /machineAllocation/);
  assert.match(desktop, /windows_native_qualification_machine_allocation_required/);
  assert.match(desktop, /accelerator\.machineId !== booking\.listing\.machineId/);
  assert.match(desktop, /windows_native_qualification_existing_session_not_live/);
});

test('public Windows desktop catalogue remains fail closed', () => {
  assert.match(catalogue, /if \(!os\.startsWith\('linux'\)\) return false/);
  assert.doesNotMatch(
    catalogue,
    /nativeDesktopStreamingAvailable[\s\S]{0,400}return true/,
  );
});

test('rental GPU authority recognizes only Windows-native Cloud Desktop sessions', () => {
  assert.match(
    authority,
    /runtimeBackend: WorkspaceRuntimeBackend\.WINDOWS_NATIVE/,
  );
  assert.match(
    authority,
    /slug: 'cloud-desktop'/,
  );
  assert.doesNotMatch(
    authority,
    /'security-lab', 'cloud-desktop'/,
  );
});
test('private qualification only reads the global Cloud Desktop definition', () => {
  assert.match(desktop, /workspaceDefinition\.findUnique/);
  assert.match(
    desktop,
    /windows_native_qualification_cloud_desktop_definition_missing/,
  );
  assert.doesNotMatch(desktop, /workspaceDefinition\.upsert/);
  assert.doesNotMatch(desktop, /WorkspaceRelease\.UPCOMING/);
});


test('private qualification rearm only releases its own never-started AGENT_OFFLINE allocation', () => {
  assert.match(desktop, /SessionTerminationReason\.AGENT_OFFLINE/);
  assert.match(desktop, /startedAt: null/);
  assert.match(desktop, /gatewayLastSeenAt: null/);
  assert.match(desktop, /liveMachineAllocations\.length === 0/);
  assert.match(desktop, /liveAcceleratorAllocations\.length === 1/);
  assert.match(
    desktop,
    /liveAcceleratorAllocations\[0\]\?\.bookingId === priorQualification\.id/,
  );
  assert.match(desktop, /status: ResourceAllocationStatus\.RELEASED/);
  assert.match(desktop, /bookingId: priorQualification\.id/);
});


test('private qualification host-gate trace stays secret-free', () => {
  assert.match(desktop, /event: 'windows_native_qualification_host_not_ready'/);
  assert.match(desktop, /heartbeatAgeSeconds/);
  assert.match(desktop, /heartbeatMaxAgeSeconds/);
  assert.match(desktop, /acceleratorUuidMatch/);
  assert.doesNotMatch(desktop, /windows_native_qualification_host_not_ready[\s\S]{0,1200}mediaToken/);
  assert.doesNotMatch(desktop, /windows_native_qualification_host_not_ready[\s\S]{0,1200}accessGrant/);
});
