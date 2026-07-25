const downloads = {
  windows: process.env.GPUBNB_HOST_WINDOWS_URL,
  linux: process.env.GPUBNB_HOST_LINUX_URL,
  macos: process.env.GPUBNB_HOST_MACOS_URL,
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
  const available = isAllowedDownloadUrl(target);

  if (checkOnly) {
    return Response.json(
      { platform, label: labels[platform], available },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!available) {
    return Response.json(
      {
        error: 'installer_not_configured',
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
