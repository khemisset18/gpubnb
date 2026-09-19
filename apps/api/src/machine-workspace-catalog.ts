import { MachineWorkspaceState, WorkspaceRelease, type PrismaClient } from '@prisma/client';

import { analyzeWorkspace, type MachineCapabilities } from './workspace-compatibility.js';
import { workspaceManifest, workspaceManifests, type WorkspaceManifest } from './workspace-manifests.js';

// Executable means there is a real runtime path behind the catalogue card: a
// container image, agent launch profile, API/gateway lifecycle and renter route.
// Compatibility remains machine-specific. Cloud Desktop, Creator, CAD and Gaming
// currently have a qualified Linux/Selkies backend only. A future Windows-native
// backend must expose its own independently measured capability before these slugs
// may become bookable on Windows; desktopGpuRenderingAvailable must never be used
// as a Windows escape hatch because it represents the Linux desktop-rendering path.
export const executableWorkspaceSlugs = [
  'compute', 'developer', 'data', 'ai', 'video', 'audio', 'api', 'mobile', 'security-lab',
  'cloud-desktop', 'creator', 'cad', 'gaming',
] as const;
export type ExecutableWorkspaceSlug = typeof executableWorkspaceSlugs[number];

const linuxDesktopWorkspaceSlugs = new Set<string>(['cloud-desktop', 'creator', 'cad', 'gaming']);

export function isExecutableWorkspaceSlug(value: string): value is ExecutableWorkspaceSlug {
  return executableWorkspaceSlugs.includes(value as ExecutableWorkspaceSlug);
}

function isWorkspaceRuntimeAvailable(machine: MachineCapabilities, slug: string): boolean {
  if (!isExecutableWorkspaceSlug(slug)) return false;
  if (!linuxDesktopWorkspaceSlugs.has(slug)) return true;

  // This capability describes the qualified Linux/Selkies path and nothing
  // else. Require Linux positively rather than merely excluding Windows: a
  // future/unknown OS must never inherit a desktop backend by accident. The
  // Windows-native backend gets its own independently measured branch.
  const os = machine.operatingSystem?.trim().toLowerCase() ?? '';
  if (!os.startsWith('linux')) return false;
  return machine.desktopGpuRenderingAvailable;
}

export function compatibleWorkspaceChoices(machine: MachineCapabilities) {
  // Legacy pre-booking endpoint kept for compatibility with older clients. The
  // modern chooser uses the full catalogue endpoint and only enables cards that
  // are both compatible and bookable.
  return workspaceManifests
    .filter((manifest) => manifest.release === 'BETA' && manifest.slug === 'compute')
    .map((manifest) => {
      const compatibility = analyzeWorkspace(machine, manifest);
      return {
        ...manifest,
        compatibility,
        compatible: compatibility.state === 'READY' || compatibility.state === 'LIMITED',
      };
    });
}

export function allWorkspaceCompatibility(machine: MachineCapabilities) {
  // Full catalogue view: every manifest gets a real, machine-specific verdict.
  // A workspace is bookable only when the runtime exists AND the current host
  // actually satisfies both its requirements and the backend/platform gate.
  return workspaceManifests.map((manifest) => {
    const compatibility = analyzeWorkspace(machine, manifest);
    const compatible = compatibility.state === 'READY' || compatibility.state === 'LIMITED';
    return {
      ...manifest,
      compatibility,
      compatible,
      bookable: compatible && isWorkspaceRuntimeAvailable(machine, manifest.slug),
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
      desktopGpuRenderingAvailable: true,
    },
  });
  if (!machine) throw new Error('machine_not_found');

  const compatibility = analyzeWorkspace(machine, manifest);
  if (compatibility.state !== 'READY' && compatibility.state !== 'LIMITED') {
    throw new Error(`${slug}_workspace_incompatible`);
  }
  if (!isWorkspaceRuntimeAvailable(machine, slug)) {
    throw new Error(`${slug}_workspace_runtime_unavailable`);
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