/**
 * Pure, fail-closed feature gate shared by catalogue code and API policy.
 * Keep this independent of config.ts so capability/catalogue unit tests can
 * import it without requiring the complete server environment.
 */
export function windowsNativeCommercialReleaseEnabled(): boolean {
  return process.env.WINDOWS_NATIVE_RENTALS_ENABLED === 'true';
}
