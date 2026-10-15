// URL publique de l’API vue par le navigateur.
// The private app and API are served by the same HTTPS origin.
// The public hosted build replaces these defaults from its configured origins.
const GPUBNB_PRIVATE_HTTPS_ORIGIN = window.location?.protocol === "https:";

window.GPUBNB_API_URL = window.GPUBNB_API_URL ||
  (GPUBNB_PRIVATE_HTTPS_ORIGIN ? window.location.origin : "/api");

window.GPUBNB_GATEWAY_URL = window.GPUBNB_GATEWAY_URL ||
  (GPUBNB_PRIVATE_HTTPS_ORIGIN ? window.location.origin : "http://localhost:3000");

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
