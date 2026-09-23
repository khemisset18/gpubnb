import { WorkspaceRuntimeBackend } from '@prisma/client';

export const WINDOWS_NATIVE_BROWSER_INPUT_BYTES = 32;

export function gatewayRuntimeBackends(): WorkspaceRuntimeBackend[] {
  return [WorkspaceRuntimeBackend.CONTAINER, WorkspaceRuntimeBackend.WINDOWS_NATIVE];
}

export function isWindowsNativeRuntime(backend: WorkspaceRuntimeBackend): boolean {
  return backend === WorkspaceRuntimeBackend.WINDOWS_NATIVE;
}

export function windowsNativeUpgradeAllowed(
  backend: WorkspaceRuntimeBackend,
  suffix: string,
  search: string,
): boolean {
  if (!isWindowsNativeRuntime(backend)) return true;
  return suffix === 'native-stream' && search === '';
}

export function browserGatewayFrameAllowed(
  backend: WorkspaceRuntimeBackend,
  binary: boolean,
  byteLength: number,
): boolean {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return false;
  if (!isWindowsNativeRuntime(backend)) return true;
  return binary && byteLength === WINDOWS_NATIVE_BROWSER_INPUT_BYTES;
}

export function upstreamGatewayFrameAllowed(
  backend: WorkspaceRuntimeBackend,
  binary: boolean,
  closing: boolean,
): boolean {
  if (closing || !isWindowsNativeRuntime(backend)) return true;
  return binary;
}
