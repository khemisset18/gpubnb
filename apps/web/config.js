// URL publique de l’API vue par le navigateur. En production, le build garde
// `/api` et génère un proxy Netlify vers GPUBNB_API_ORIGIN.
window.GPUBNB_API_URL = window.GPUBNB_API_URL || "/api";
// Le build remplace cette valeur de développement par GPUBNB_GATEWAY_ORIGIN
// (ou GPUBNB_API_ORIGIN lorsque API et gateway partagent le même runtime).
window.GPUBNB_GATEWAY_URL = window.GPUBNB_GATEWAY_URL || "http://localhost:3000";
window.GPUBNB_CONFIG = {
  apiBase: window.GPUBNB_API_URL,
  workspaceGatewayBase: window.GPUBNB_GATEWAY_URL,
  hostRelease: {
    repository: "khemisset18/gpubnb",
    channel: "host-test-latest",
    platforms: {
      windows: { architecture: "x64", filename: "gpubnb-host-windows-x64.zip" },
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
