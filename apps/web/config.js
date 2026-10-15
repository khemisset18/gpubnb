// URL publique de l’API vue par le navigateur.
window.GPUBNB_API_URL = window.GPUBNB_API_URL || "/api";
window.GPUBNB_GATEWAY_URL = window.GPUBNB_GATEWAY_URL || "http://localhost:3000";

// BEGIN_PRIVATE_HTTPS_SAME_ORIGIN
// The private site shares one HTTPS origin between HTML pages and its API.
// Public hosted builds strip this block and use configured API/gateway origins.
if (window.location?.protocol === "https:") {
  if (window.GPUBNB_API_URL === "/api") window.GPUBNB_API_URL = window.location.origin;
  if (window.GPUBNB_GATEWAY_URL === "http://localhost:3000") window.GPUBNB_GATEWAY_URL = window.location.origin;
}
// END_PRIVATE_HTTPS_SAME_ORIGIN

window.GPUBNB_CONFIG = {
  apiBase: window.GPUBNB_API_URL,
  workspaceGatewayBase: window.GPUBNB_GATEWAY_URL,
  hostRelease: {
    repository: "khemisset18/gpubnb",
    channel: "host-test-latest",
    platforms: {
      windows: { architecture: "x64", filename: "gpubnb-host-windows-x64.exe" },
      linux: { architecture: "x64", filename: "gpubnb-host-linux-x64.deb" },
      macos: { architecture: "arm64", filename: "gpubnb-host-macos-arm64.dmg" }
    }
  }
};
window.GPUBNB_BUILD = window.GPUBNB_BUILD || {
  version: "0.2.0",
  commit: "local",
  environment: "Devnet",
  date: "développement"
};
