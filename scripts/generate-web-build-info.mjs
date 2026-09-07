import { readFile, writeFile } from 'node:fs/promises';

const configPath = new URL('../apps/web/config.js', import.meta.url);
const redirectsPath = new URL('../apps/web/_redirects', import.meta.url);
const headersPath = new URL('../apps/web/_headers', import.meta.url);
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const context = process.env.CONTEXT || process.env.GPUBNB_ENVIRONMENT || 'development';
const reviewId = process.env.REVIEW_ID || '';
const isDeployPreview = context === 'deploy-preview' && /^[1-9]\d*$/.test(reviewId);
const isHostedBuild = ['production', 'deploy-preview', 'branch-deploy'].includes(context);

function normalizeOrigin(name, raw, { requireHttps }) {
  if (!raw) throw new Error(`${name}_required`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name}_invalid_url`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name}_invalid_protocol`);
  if (requireHttps && parsed.protocol !== 'https:') throw new Error(`${name}_https_required`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`${name}_must_be_origin_only`);
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new Error(`${name}_must_be_origin_only`);
  return parsed.origin;
}

const configuredApiOrigin = isDeployPreview
  ? process.env.GPUBNB_PREVIEW_API_ORIGIN || process.env.GPUBNB_API_ORIGIN
  : process.env.GPUBNB_API_ORIGIN;
const apiOrigin = normalizeOrigin(
  'GPUBNB_API_ORIGIN',
  configuredApiOrigin || (isHostedBuild ? '' : 'http://localhost:3000'),
  { requireHttps: isHostedBuild },
);
const configuredGatewayOrigin = isDeployPreview
  ? process.env.GPUBNB_PREVIEW_GATEWAY_ORIGIN || process.env.GPUBNB_GATEWAY_ORIGIN
  : process.env.GPUBNB_GATEWAY_ORIGIN;
const gatewayOrigin = normalizeOrigin(
  'GPUBNB_GATEWAY_ORIGIN',
  configuredGatewayOrigin || apiOrigin,
  { requireHttps: isHostedBuild },
);
const gatewaySocketOrigin = gatewayOrigin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

const value = {
  version: packageJson.version,
  commit: (process.env.COMMIT_REF || process.env.GITHUB_SHA || 'local').slice(0, 7),
  environment: context,
  date: new Date().toISOString(),
};

let source = await readFile(configPath, 'utf8');
const apiUpdated = source.replace(
  /window\.GPUBNB_API_URL = window\.GPUBNB_API_URL \|\| [^;]+;/,
  'window.GPUBNB_API_URL = window.GPUBNB_API_URL || "/api";',
);
if (apiUpdated === source && !source.includes('window.GPUBNB_API_URL = window.GPUBNB_API_URL || "/api";')) {
  throw new Error('api_url_marker_not_found');
}
source = apiUpdated;
const gatewayUpdated = source.replace(
  /window\.GPUBNB_GATEWAY_URL = window\.GPUBNB_GATEWAY_URL \|\| [^;]+;/,
  `window.GPUBNB_GATEWAY_URL = window.GPUBNB_GATEWAY_URL || ${JSON.stringify(gatewayOrigin)};`,
);
if (gatewayUpdated === source) throw new Error('gateway_url_marker_not_found');
source = gatewayUpdated;
const buildUpdated = source.replace(
  /window\.GPUBNB_BUILD = window\.GPUBNB_BUILD \|\| \{[\s\S]*?\n\};/,
  `window.GPUBNB_BUILD = window.GPUBNB_BUILD || ${JSON.stringify(value, null, 2)};`,
);
if (buildUpdated === source) throw new Error('build_info_marker_not_found');
await writeFile(configPath, buildUpdated, 'utf8');

await writeFile(redirectsPath, `/api/* ${apiOrigin}/:splat 200!\n`, 'utf8');
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  `connect-src 'self' ${gatewayOrigin} ${gatewaySocketOrigin} https://api.devnet.solana.com https://*.supabase.co wss://*.supabase.co`,
  'upgrade-insecure-requests',
].join('; ');
await writeFile(headersPath, `/*\n  Content-Security-Policy: ${csp}\n`, 'utf8');

console.log(JSON.stringify({
  event: 'web_public_origins_generated',
  context,
  apiOrigin,
  gatewayOrigin,
  deployPreview: isDeployPreview,
}));
