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
  const os = machine.operatingSystem?.trim().toLowerCase() ?? '';
  if (os.startsWith('windows')) {
    // Machine capabilities alone cannot prove exact-listing GPU allocation,
    // owner consent, current heartbeat, or payment readiness. The Windows
    // marketplace replaces these four verdicts with nativeRentalEligibility;
    // every other Windows slug must remain unbookable (never Docker/WSL2).
    return false;
  }
  // Unknown and non-Linux hosts cannot inherit a Docker/Selkies runtime.
  if (!os.startsWith('linux')) return false;
  return !linuxDesktopWorkspaceSlugs.has(slug) || machine.desktopGpuRenderingAvailable;
}

export function compatibleWorkspaceChoices(machine: MachineCapabilities) {
  // Legacy pre-booking endpoint kept for compatibility with older clients. The
  // modern chooser uses the full catalogue endpoint and only enables cards that
  // are both compatible and bookable.
  // This endpoint only advertises Compute, which is a Linux container/GPU-proof
  // path. Never expose it as a Windows-native Workspace or a WSL2 fallback.
  if ((machine.operatingSystem ?? '').trim().toLowerCase().startsWith('windows')) return [];
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
      gpuUuid: true, nativeDesktopStreamingAvailable: true,
      nativeDesktopStreamingGpuUuid: true,
    },
  });
  if (!machine) throw new Error('machine_not_found');

  // The old ensureCompatibleMachineWorkspace path creates a Docker-prepared
  // session. Windows native sessions need a separate, exact-GPU allocation and
  // helper-authorized READY path; never reinterpret them as Docker sessions.
  if ((machine.operatingSystem ?? '').trim().toLowerCase().startsWith('windows')
      && linuxDesktopWorkspaceSlugs.has(slug)) {
    throw new Error('windows_native_workspace_requires_native_route');
  }
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
