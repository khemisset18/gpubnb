// URL publique de l’API, sans slash final. Laisser vide uniquement si le frontend et l’API partagent le même domaine.
window.GPUBNB_API_URL = window.GPUBNB_API_URL || "/api";
// Interactive workspaces need a real WebSocket-capable origin. The regular API
// can stay behind Netlify's /api rewrite, but the browser must leave that rewrite
// before following gateway redirects or opening the code-server WebSocket.
window.GPUBNB_GATEWAY_URL = window.GPUBNB_GATEWAY_URL || "https://gpubnb.onrender.com";
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
