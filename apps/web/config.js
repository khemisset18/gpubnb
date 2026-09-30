// URL publique de l’API vue par le navigateur.
// Private Stage 3 Render deployments are intentionally same-origin so PC2 can
// authenticate and open the native desktop without changing the public Netlify site.
const GPUBNB_STAGE3_RENDER_SAME_ORIGIN =
  window.location?.protocol === "https:" &&
  window.location?.hostname?.endsWith(".onrender.com");

window.GPUBNB_API_URL = window.GPUBNB_API_URL ||
  (GPUBNB_STAGE3_RENDER_SAME_ORIGIN ? window.location.origin : "/api");

window.GPUBNB_GATEWAY_URL = window.GPUBNB_GATEWAY_URL ||
  (GPUBNB_STAGE3_RENDER_SAME_ORIGIN ? window.location.origin : "http://localhost:3000");

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
