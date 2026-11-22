import type { WorkspaceManifest } from './workspace-manifests.js';
import { WINDOWS_NATIVE_GPU_UUID_RE } from './windows-native-capability.js';

/**
 * Native Windows desktop candidates. This list deliberately does not grant
 * commercial eligibility: API release, owner opt-in, signed current heartbeat,
 * resource authority, helper proof and isolation remain separate gates.
 */
export const WINDOWS_NATIVE_DESKTOP_SLUGS = [
  'cloud-desktop', 'creator', 'cad', 'gaming',
] as const;
export type WindowsNativeDesktopSlug = typeof WINDOWS_NATIVE_DESKTOP_SLUGS[number];

export function isWindowsNativeDesktopSlug(value: string): value is WindowsNativeDesktopSlug {
  return WINDOWS_NATIVE_DESKTOP_SLUGS.some(slug => slug === value);
}

export type WindowsNativeHostCapabilities = {
  operatingSystem: string | null | undefined;
  nativeDesktopStreamingAvailable?: boolean | null;
  nativeDesktopStreamingGpuUuid?: string | null;
  ramTotalMiB: number | null | undefined;
  diskTotalMiB: number | null | undefined;
  vramMiB: number | null | undefined;
};

export type WindowsNativeCandidate = {
  candidate: boolean;
  score: number;
  state: 'READY' | 'INCOMPATIBLE';
  missing: string[];
  reasons: string[];
  backend: 'WINDOWS_NATIVE';
};

/**
 * Static, machine-specific capability screening only.
 *
 * A "candidate" is NOT a READY streaming session or security qualification.
 * In particular, signed heartbeat information cannot prove that a Windows
 * renter session is isolated, nor that STOP will clean up an IddCx display.
 * Those must be checked by the native Agent/helper on each actual lease.
 *
 * For an exact-accelerator listing, expectedGpuUuid MUST be the accelerator
 * hardwareUuid from the database (never a value supplied by the browser).
 * If absent we fail closed instead of treating a machine-wide capability as
 * authority over an arbitrary physical GPU.
 */
export function windowsNativeWorkspaceCandidate(
  machine: WindowsNativeHostCapabilities,
  manifest: WorkspaceManifest,
  expectedGpuUuid: string | null | undefined,
): WindowsNativeCandidate {
  const missing: string[] = [];
  const reasons: string[] = [];
  const os = (machine.operatingSystem ?? '').trim().toLowerCase();
  if (!os.startsWith('windows')) missing.push('Hôte Windows natif requis');

  const reportedGpu = machine.nativeDesktopStreamingGpuUuid?.trim() ?? '';
  const leasedGpu = expectedGpuUuid?.trim() ?? '';
  if (!machine.nativeDesktopStreamingAvailable) {
    missing.push('Capture Windows native et encodeur matériel non démontrés');
  }
  if (!WINDOWS_NATIVE_GPU_UUID_RE.test(reportedGpu)
      || !WINDOWS_NATIVE_GPU_UUID_RE.test(leasedGpu)
      || reportedGpu.toLowerCase() !== leasedGpu.toLowerCase()) {
    missing.push('GPU Windows natif différent du GPU exact de la location');
  }
  if (machine.ramTotalMiB === null || machine.ramTotalMiB === undefined
      || machine.ramTotalMiB < manifest.minimum.ramMiB) {
    missing.push('RAM Windows native insuffisante ou non mesurée');
  }
  if (machine.diskTotalMiB === null || machine.diskTotalMiB === undefined
      || machine.diskTotalMiB < manifest.minimum.diskMiB) {
    missing.push('Stockage Windows natif insuffisant ou non mesuré');
  }
  if (manifest.minimum.vramMiB
      && (machine.vramMiB === null || machine.vramMiB === undefined
        || machine.vramMiB < manifest.minimum.vramMiB)) {
    missing.push('VRAM Windows native insuffisante ou non mesurée');
  }
  // No Docker, WSL2, Linux DRM or NVIDIA Container Toolkit required here.
  // A successful helper/self-test is still mandatory for each rental.
  if (missing.length === 0) {
    reasons.push('Hôte Windows et capacité native du GPU exact déclarés');
    reasons.push('Démarrage possible uniquement après preuve physique et autorisation de session');
  }
  return {
    candidate: missing.length === 0,
    score: missing.length === 0 ? 100 : Math.max(0, 100 - missing.length * 25),
    state: missing.length === 0 ? 'READY' : 'INCOMPATIBLE',
    missing,
    reasons,
    backend: 'WINDOWS_NATIVE',
  };
}

/** Owner-side static analysis for native Windows workspace consent.
 * Audio is wired but still unqualified on hardware; Gaming also lacks native
 * XInput. A software path or synthetic proof must not mark either profile
 * ready or permit owner opt-in.
 */
export function windowsNativeWorkspaceOwnerAnalysis(
  machine: WindowsNativeHostCapabilities,
  manifest: WorkspaceManifest,
  slug: WindowsNativeDesktopSlug,
  expectedGpuUuid: string | null | undefined,
): WindowsNativeCandidate {
  const candidate = windowsNativeWorkspaceCandidate(machine, manifest, expectedGpuUuid);
  const missingCapability = slug === 'cloud-desktop'
    ? 'Audio navigateur WASAPI non qualifié sur matériel réel'
    : slug === 'gaming'
      ? 'Audio non qualifié ou manette XInput native absente'
      : null;
  if (!missingCapability) return candidate;
  return {
    ...candidate,
    candidate: false,
    score: 0,
    state: 'INCOMPATIBLE',
    missing: [...candidate.missing, missingCapability],
    reasons: [],
  };
}
