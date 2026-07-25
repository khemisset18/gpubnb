const releaseBase = 'https://github.com/khemisset18/gpubnb/releases/download/host-test-latest';

const downloads = {
  windows: process.env.GPUBNB_HOST_WINDOWS_URL || `${releaseBase}/gpubnb-host-windows-x64.exe`,
  linux: process.env.GPUBNB_HOST_LINUX_URL || `${releaseBase}/gpubnb-host-linux-x64.deb`,
  macos: process.env.GPUBNB_HOST_MACOS_URL || `${releaseBase}/gpubnb-host-macos-arm64.dmg`,
};

const labels = {
  windows: 'Windows',
  linux: 'Linux',
  macos: 'macOS',
};

function isAllowedDownloadUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function isPublished(target) {
  if (!isAllowedDownloadUrl(target)) return false;
  try {
    const response = await fetch(target, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'user-agent': 'GPUbnb-download-check/1.0' },
    });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

export default async (request) => {
  const url = new URL(request.url);
  const platform = url.searchParams.get('platform');
  const checkOnly = url.searchParams.get('check') === '1';

  if (!platform || !(platform in downloads)) {
    return Response.json(
      { error: 'unsupported_platform', supported: Object.keys(downloads) },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const target = downloads[platform];
  const available = await isPublished(target);

  if (checkOnly) {
    return Response.json(
      { platform, label: labels[platform], available, channel: 'test' },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!available) {
    return Response.json(
      {
        error: 'installer_not_published',
        platform,
        message: `L’installateur GPUbnb Host pour ${labels[platform]} n’est pas encore publié.`,
      },
      { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '3600' } },
    );
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
};
