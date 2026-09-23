import { sanitizeAccelerators } from './accelerator-telemetry.js';

export const WINDOWS_NATIVE_GPU_UUID_RE =
  /^GPU-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export type WindowsNativeCapabilityInput = {
  operatingSystem: string | null | undefined;
  available: boolean | undefined;
  gpuUuid: string | null | undefined;
  rawAccelerators: unknown;
};

export type WindowsNativeCapabilityResult =
  | { ok: true; available: false; gpuUuid: null }
  | { ok: true; available: true; gpuUuid: string }
  | { ok: false };

export function validateWindowsNativeCapability(
  input: WindowsNativeCapabilityInput,
): WindowsNativeCapabilityResult {
  const gpuUuid = input.gpuUuid?.trim() || null;

  if (input.available !== true) {
    return gpuUuid ? { ok: false } : { ok: true, available: false, gpuUuid: null };
  }

  const os = input.operatingSystem?.trim().toLowerCase() ?? '';
  if (!os.startsWith('windows') || !gpuUuid || !WINDOWS_NATIVE_GPU_UUID_RE.test(gpuUuid)) {
    return { ok: false };
  }

  const accelerators = sanitizeAccelerators(input.rawAccelerators);
  const exactGpuPresent = accelerators.some((accelerator) =>
    accelerator.kind === 'GPU'
    && accelerator.available
    && accelerator.vendor.trim().toLowerCase() === 'nvidia'
    && accelerator.deviceId.toLowerCase() === gpuUuid.toLowerCase()
  );

  return exactGpuPresent
    ? { ok: true, available: true, gpuUuid }
    : { ok: false };
}
