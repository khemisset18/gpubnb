import type { WorkspaceManifest } from './workspace-manifests.js';

// desktopGpuRenderingAvailable is deliberately a separate, independently-measured
// field from cudaVersion/nvidiaRuntimeAvailable: CUDA compute capability does not
// prove a desktop rendering path. Keep compatibility capability-driven instead of
// maintaining a fragile GPU model allowlist.
export type MachineCapabilities = {
  ramTotalMiB: number | null;
  diskTotalMiB: number | null;
  vramMiB: number | null;
  cudaVersion: string | null;
  dockerAvailable: boolean;
  nvidiaRuntimeAvailable: boolean;
  operatingSystem: string | null;
  virtualizationAvailable: boolean;
  desktopGpuRenderingAvailable: boolean;
};

export type CompatibilityReasonCode =
  | 'RAM_NOT_MEASURED'
  | 'RAM_BELOW_MINIMUM'
  | 'RAM_BELOW_RECOMMENDED'
  | 'RAM_RECOMMENDED'
  | 'DISK_NOT_MEASURED'
  | 'DISK_BELOW_MINIMUM'
  | 'DISK_BELOW_RECOMMENDED'
  | 'DISK_RECOMMENDED'
  | 'VRAM_NOT_MEASURED'
  | 'VRAM_BELOW_MINIMUM'
  | 'VRAM_BELOW_RECOMMENDED'
  | 'VRAM_RECOMMENDED'
  | 'CUDA_REQUIRED'
  | 'CUDA_AVAILABLE'
  | 'DOCKER_REQUIRED'
  | 'DOCKER_AVAILABLE'
  | 'NVIDIA_RUNTIME_REQUIRED'
  | 'NVIDIA_RUNTIME_AVAILABLE'
  | 'VIRTUALIZATION_REQUIRED'
  | 'VIRTUALIZATION_AVAILABLE'
  | 'DESKTOP_GPU_RENDERING_REQUIRED'
  | 'DESKTOP_GPU_RENDERING_AVAILABLE';

export type CompatibilityResult = {
  score: number;
  state: 'READY' | 'LIMITED' | 'INSTALL_REQUIRED' | 'INCOMPATIBLE';
  reasons: string[];
  missing: string[];
  reasonCodes: CompatibilityReasonCode[];
  missingCodes: CompatibilityReasonCode[];
};

type CapacityKind = 'RAM' | 'DISK' | 'VRAM';

type FlagDefinition = {
  required: boolean | undefined;
  available: boolean;
  label: string;
  missingCode: CompatibilityReasonCode;
  availableCode: CompatibilityReasonCode;
};

export function analyzeWorkspace(machine: MachineCapabilities, manifest: WorkspaceManifest): CompatibilityResult {
  let score = 100;
  const reasons: string[] = [];
  const missing: string[] = [];
  const reasonCodes: CompatibilityReasonCode[] = [];
  const missingCodes: CompatibilityReasonCode[] = [];
  const min = manifest.minimum;
  const rec = manifest.recommended;

  const check = (
    actual: number | null,
    minimum: number,
    recommended: number,
    label: string,
    kind: CapacityKind,
  ) => {
    if (actual === null) {
      score -= 20;
      missing.push(`${label} non mesuré`);
      missingCodes.push(`${kind}_NOT_MEASURED`);
    } else if (actual < minimum) {
      score -= 45;
      missing.push(`${label}: ${actual} < ${minimum} MiB`);
      missingCodes.push(`${kind}_BELOW_MINIMUM`);
    } else if (actual < recommended) {
      score -= 12;
      reasons.push(`${label} suffisant mais inférieur au niveau recommandé`);
      reasonCodes.push(`${kind}_BELOW_RECOMMENDED`);
    } else {
      reasons.push(`${label} au niveau recommandé`);
      reasonCodes.push(`${kind}_RECOMMENDED`);
    }
  };

  check(machine.ramTotalMiB, min.ramMiB, rec.ramMiB, 'RAM', 'RAM');
  check(machine.diskTotalMiB, min.diskMiB, rec.diskMiB, 'Stockage', 'DISK');
  if (min.vramMiB) {
    check(machine.vramMiB, min.vramMiB, rec.vramMiB ?? min.vramMiB, 'VRAM', 'VRAM');
  }

  const flags: FlagDefinition[] = [
    {
      required: min.cuda,
      available: Boolean(machine.cudaVersion),
      label: 'CUDA',
      missingCode: 'CUDA_REQUIRED',
      availableCode: 'CUDA_AVAILABLE',
    },
    {
      required: min.docker,
      available: machine.dockerAvailable,
      label: 'Docker',
      missingCode: 'DOCKER_REQUIRED',
      availableCode: 'DOCKER_AVAILABLE',
    },
    {
      required: min.nvidiaRuntime,
      available: machine.nvidiaRuntimeAvailable,
      label: 'NVIDIA Container Toolkit',
      missingCode: 'NVIDIA_RUNTIME_REQUIRED',
      availableCode: 'NVIDIA_RUNTIME_AVAILABLE',
    },
    {
      required: min.virtualization,
      available: machine.virtualizationAvailable,
      label: 'Virtualisation',
      missingCode: 'VIRTUALIZATION_REQUIRED',
      availableCode: 'VIRTUALIZATION_AVAILABLE',
    },
    {
      required: min.desktopGpuRendering,
      available: machine.desktopGpuRenderingAvailable,
      label: 'Rendu GPU desktop (/dev/dri + NVIDIA Container Toolkit)',
      missingCode: 'DESKTOP_GPU_RENDERING_REQUIRED',
      availableCode: 'DESKTOP_GPU_RENDERING_AVAILABLE',
    },
  ];

  for (const flag of flags) {
    if (flag.required && !flag.available) {
      score -= 30;
      missing.push(`${flag.label} requis`);
      missingCodes.push(flag.missingCode);
    } else if (flag.required) {
      reasons.push(`${flag.label} disponible`);
      reasonCodes.push(flag.availableCode);
    }
  }

  score = Math.max(0, Math.min(100, score));
  const hardMissing = missingCodes.some((code) => !code.endsWith('_NOT_MEASURED'));
  const state = score < 45 || (hardMissing && score < 70)
    ? 'INCOMPATIBLE'
    : missing.length
      ? 'INSTALL_REQUIRED'
      : score < 85
        ? 'LIMITED'
        : 'READY';

  return { score, state, reasons, missing, reasonCodes, missingCodes };
}
