import { MachineWorkspaceState, WorkspaceRelease, type PrismaClient } from '@prisma/client';

import { analyzeWorkspace, type MachineCapabilities } from './workspace-compatibility.js';
import { workspaceManifest, workspaceManifests, type WorkspaceManifest } from './workspace-manifests.js';

export const executableWorkspaceSlugs = ['compute', 'developer'] as const;
export type ExecutableWorkspaceSlug = typeof executableWorkspaceSlugs[number];

export function isExecutableWorkspaceSlug(value: string): value is ExecutableWorkspaceSlug {
  return executableWorkspaceSlugs.includes(value as ExecutableWorkspaceSlug);
}

export function compatibleWorkspaceChoices(machine: MachineCapabilities) {
  return workspaceManifests
    .filter((manifest) => manifest.release === 'BETA' && isExecutableWorkspaceSlug(manifest.slug))
    .map((manifest) => {
      const compatibility = analyzeWorkspace(machine, manifest);
      return {
        ...manifest,
        compatibility,
        compatible: compatibility.state === 'READY' || compatibility.state === 'LIMITED',
      };
    });
}

export async function ensureCompatibleMachineWorkspace(
  db: PrismaClient,
  machineId: string,
  slug: ExecutableWorkspaceSlug,
) {
  const manifest = workspaceManifest(slug) as WorkspaceManifest;
  const machine = await db.machine.findUnique({
    where: { id: machineId },
    select: {
      id: true, ramTotalMiB: true, diskTotalMiB: true, vramMiB: true,
      cudaVersion: true, dockerAvailable: true, nvidiaRuntimeAvailable: true,
      operatingSystem: true, virtualizationAvailable: true,
    },
  });
  if (!machine) throw new Error('machine_not_found');

  const compatibility = analyzeWorkspace(machine, manifest);
  if (compatibility.state !== 'READY' && compatibility.state !== 'LIMITED') {
    throw new Error(`${slug}_workspace_incompatible`);
  }

  const definition = await db.workspaceDefinition.upsert({
    where: { slug },
    update: {
      version: 1,
      name: manifest.name,
      category: manifest.category,
      release: WorkspaceRelease.BETA,
      manifest: JSON.parse(JSON.stringify(manifest)),
    },
    create: {
      slug,
      version: 1,
      name: manifest.name,
      category: manifest.category,
      release: WorkspaceRelease.BETA,
      manifest: JSON.parse(JSON.stringify(manifest)),
    },
  });

  return db.machineWorkspace.upsert({
    where: { machineId_workspaceId: { machineId, workspaceId: definition.id } },
    update: {
      compatibilityScore: compatibility.score,
      state: compatibility.state as MachineWorkspaceState,
      analysis: compatibility,
      analyzedAt: new Date(),
    },
    create: {
      machineId,
      workspaceId: definition.id,
      compatibilityScore: compatibility.score,
      state: compatibility.state as MachineWorkspaceState,
      analysis: compatibility,
    },
  });
}
