import test from 'node:test';
import assert from 'node:assert/strict';

import { compatibleWorkspaceChoices, ensureCompatibleMachineWorkspace } from '../src/machine-workspace-catalog.js';
import { windowsNativeWorkspaceOwnerAnalysis } from '../src/windows-native-workspace-policy.js';
import { workspaceManifest } from '../src/workspace-manifests.js';

const highEndWindows = {
  id: 'machine-windows',
  ramTotalMiB: 65_536,
  diskTotalMiB: 2_000_000,
  vramMiB: 24_576,
  cudaVersion: '13.1',
  dockerAvailable: true,
  nvidiaRuntimeAvailable: true,
  operatingSystem: 'Windows',
  virtualizationAvailable: true,
  // This is deliberately inconsistent: the field describes the qualified Linux
  // /dev/dri path. Even if a bad/stale heartbeat ever sets it on Windows, the
  // server-side runtime gate must still refuse the desktop backend.
  desktopGpuRenderingAvailable: true,
};

for (const slug of ['cloud-desktop', 'creator', 'cad', 'gaming'] as const) {
  test(`${slug} fails closed on Windows before any workspace row can be created`, async () => {
    let definitionUpserts = 0;
    let machineWorkspaceUpserts = 0;
    const db = {
      machine: {
        findUnique: async () => highEndWindows,
      },
      workspaceDefinition: {
        upsert: async () => {
          definitionUpserts += 1;
          return { id: 'definition' };
        },
      },
      machineWorkspace: {
        upsert: async () => {
          machineWorkspaceUpserts += 1;
          return { id: 'machine-workspace' };
        },
      },
    };

    await assert.rejects(
      () => ensureCompatibleMachineWorkspace(db as never, highEndWindows.id, slug),
      (error: unknown) => error instanceof Error
        && error.message === 'windows_native_workspace_requires_native_route',
    );
    assert.equal(definitionUpserts, 0);
    assert.equal(machineWorkspaceUpserts, 0);
  });
}

test('Windows cannot fall back to Compute or a generic Linux container Workspace', async () => {
  assert.deepEqual(compatibleWorkspaceChoices(highEndWindows), []);
  for (const slug of ['compute', 'developer', 'data'] as const) {
    let definitionUpserts = 0;
    const db = {
      machine: { findUnique: async () => highEndWindows },
      workspaceDefinition: { upsert: async () => { definitionUpserts += 1; return { id: 'definition' }; } },
      machineWorkspace: { upsert: async () => ({ id: 'machine-workspace' }) },
    };
    await assert.rejects(
      () => ensureCompatibleMachineWorkspace(db as never, highEndWindows.id, slug),
      (error: unknown) => error instanceof Error && error.message === `${slug}_workspace_runtime_unavailable`,
    );
    assert.equal(definitionUpserts, 0);
  }
});

test('owner analysis uses exact native Windows proof and never enables missing audio/controller profiles', () => {
  const measured = {
    ...highEndWindows,
    nativeDesktopStreamingAvailable: true,
    nativeDesktopStreamingGpuUuid: 'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a',
    gpuUuid: 'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a',
  };
  const expectedGpuUuid = measured.gpuUuid;
  const creator = windowsNativeWorkspaceOwnerAnalysis(measured, workspaceManifest('creator')!, 'creator', expectedGpuUuid);
  const cad = windowsNativeWorkspaceOwnerAnalysis(measured, workspaceManifest('cad')!, 'cad', expectedGpuUuid);
  const cloud = windowsNativeWorkspaceOwnerAnalysis(measured, workspaceManifest('cloud-desktop')!, 'cloud-desktop', expectedGpuUuid);
  const gaming = windowsNativeWorkspaceOwnerAnalysis(measured, workspaceManifest('gaming')!, 'gaming', expectedGpuUuid);
  assert.equal(creator.candidate, true);
  assert.equal(cad.candidate, true);
  assert.equal(cloud.state, 'INCOMPATIBLE');
  assert.ok(cloud.missing.some(reason => reason.includes('Audio')));
  assert.equal(gaming.state, 'INCOMPATIBLE');
  assert.ok(gaming.missing.some(reason => reason.includes('manette')));
  assert.equal(windowsNativeWorkspaceOwnerAnalysis(
    { ...measured, nativeDesktopStreamingGpuUuid: 'GPU-00000000-0000-0000-0000-000000000001' },
    workspaceManifest('creator')!, 'creator', expectedGpuUuid,
  ).candidate, false);
});

test('non-Linux operating systems cannot inherit the Linux desktop backend', async () => {
  for (const operatingSystem of ['Darwin', 'FreeBSD', 'unknown', '']) {
    let definitionUpserts = 0;
    const machine = { ...highEndWindows, id: `machine-${operatingSystem || 'empty'}`, operatingSystem };
    const db = {
      machine: { findUnique: async () => machine },
      workspaceDefinition: {
        upsert: async () => {
          definitionUpserts += 1;
          return { id: 'definition' };
        },
      },
      machineWorkspace: { upsert: async () => ({ id: 'machine-workspace' }) },
    };
    await assert.rejects(
      () => ensureCompatibleMachineWorkspace(db as never, machine.id, 'cloud-desktop'),
      (error: unknown) => error instanceof Error
        && error.message === 'cloud-desktop_workspace_runtime_unavailable',
    );
    assert.equal(definitionUpserts, 0);
  }
});

test('the Windows runtime gate does not disable the already-qualified Linux desktop backend', async () => {
  const linuxMachine = {
    ...highEndWindows,
    id: 'machine-linux',
    operatingSystem: 'Linux',
  };
  let definitionUpserts = 0;
  let machineWorkspaceUpserts = 0;
  const db = {
    machine: {
      findUnique: async () => linuxMachine,
    },
    workspaceDefinition: {
      upsert: async () => {
        definitionUpserts += 1;
        return { id: 'definition' };
      },
    },
    machineWorkspace: {
      upsert: async () => {
        machineWorkspaceUpserts += 1;
        return { id: 'machine-workspace' };
      },
    },
  };

  const result = await ensureCompatibleMachineWorkspace(
    db as never,
    linuxMachine.id,
    'cloud-desktop',
  );
  assert.deepEqual(result, { id: 'machine-workspace' });
  assert.equal(definitionUpserts, 1);
  assert.equal(machineWorkspaceUpserts, 1);
});


test('machine-level native proof cannot prequalify every GPU before exact accelerator binding exists', async () => {
  const windowsWithNativeProof = {
    ...highEndWindows,
    desktopGpuRenderingAvailable: false,
    nativeDesktopStreamingAvailable: true,
    nativeDesktopStreamingGpuUuid: 'GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a',
  };
  let definitionUpserts = 0;
  const db = {
    machine: {
      findUnique: async () => windowsWithNativeProof,
    },
    workspaceDefinition: {
      upsert: async () => {
        definitionUpserts += 1;
        return { id: 'definition' };
      },
    },
    machineWorkspace: {
      upsert: async () => ({ id: 'machine-workspace' }),
    },
  };

  await assert.rejects(
    () => ensureCompatibleMachineWorkspace(db as never, windowsWithNativeProof.id, 'cloud-desktop'),
    (error: unknown) => error instanceof Error
      && error.message === 'windows_native_workspace_requires_native_route',
  );
  assert.equal(
    definitionUpserts,
    0,
    'the generic Linux/container path must remain unavailable even when machine-level Windows proof exists; native eligibility requires listing-specific checks',
  );
});
