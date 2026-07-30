const repository = process.env.GPUBNB_HOST_REPOSITORY || 'khemisset18/gpubnb';
const channel = process.env.GPUBNB_HOST_RELEASE_CHANNEL || 'host-test-latest';
const allowed = {
  windows: { architecture: 'x64', filename: 'gpubnb-host-windows-x64.zip', format: 'ZIP portable' },
  linux: { architecture: 'x64', filename: 'gpubnb-host-linux-x64.deb', format: 'Paquet DEB' },
  macos: { architecture: 'arm64', filename: 'gpubnb-host-macos-arm64.dmg', format: 'Image DMG' },
};

const headers = { accept: 'application/vnd.github+json', 'user-agent': 'GPUbnb-Netlify/1.0' };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' } });
}

async function github(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    return await fetch(`https://api.github.com/repos/${repository}${path}`, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function releaseMetadata() {
  const response = await github(`/releases/tags/${encodeURIComponent(channel)}`);
  if (!response.ok) throw new Error(`github_release_${response.status}`);
  return response.json();
}

async function checksumFor(release, filename) {
  const asset = release.assets.find(item => item.name === 'SHA256SUMS.txt');
  if (!asset) return null;
  const response = await fetch(asset.browser_download_url, { headers: { 'user-agent': headers['user-agent'] } });
  if (!response.ok) return null;
  const line = (await response.text()).split(/\r?\n/).find(value => value.trim().endsWith(filename));
  const checksum = line?.trim().split(/\s+/)[0];
  return /^[a-f0-9]{64}$/i.test(checksum || '') ? checksum.toLowerCase() : null;
}

export default async request => {
  const url = new URL(request.url);
  const platform = url.searchParams.get('platform');
  const requested = allowed[platform];
  if (!requested) return json({ error: 'unsupported_platform', supported: Object.keys(allowed) }, 400);
  const architecture = url.searchParams.get('arch');
  if (architecture && architecture !== requested.architecture) {
    return json({ error: 'unsupported_architecture', platform, supported: [requested.architecture] }, 400);
  }

  try {
    const release = await releaseMetadata();
    const asset = release.assets.find(item => item.name === requested.filename);
    if (!asset) return json({ available: false, platform, architecture: requested.architecture, filename: requested.filename });
    const downloadUrl = `/.netlify/functions/host-download?platform=${platform}&download=1`;
    if (url.searchParams.get('download') === '1') {
      return new Response(null, {
        status: 302,
        headers: { location: asset.browser_download_url, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
    }
    return json({
      available: true,
      platform,
      architecture: requested.architecture,
      format: requested.format,
      filename: asset.name,
      version: release.name || release.tag_name,
      immutableVersion: release.target_commitish,
      publishedAt: release.published_at,
      size: asset.size,
      signed: false,
      sha256: await checksumFor(release, asset.name),
      downloadUrl,
    });
  } catch (error) {
    return json({ error: 'release_verification_failed', message: error.message }, 502);
  }
};
