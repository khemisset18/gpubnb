import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureCompatibleMachineWorkspace } from '../src/machine-workspace-catalog.js';

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
        && error.message === `${slug}_workspace_runtime_unavailable`,
    );
    assert.equal(definitionUpserts, 0);
    assert.equal(machineWorkspaceUpserts, 0);
  });
}

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
