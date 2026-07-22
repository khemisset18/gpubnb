import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteUrl = (process.env.DEPLOY_PRIME_URL || process.env.URL || '').replace(/\/$/, '');
const config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  redirectUrl: siteUrl ? `${siteUrl}/auth.html` : '',
};
const apiUrl = (process.env.GPUBNB_API_URL || process.env.API_URL || '').replace(/\/$/, '');

// JSON encoding prevents environment values from escaping the assignment. This
// file contains browser-public configuration only; service-role credentials are
// deliberately unsupported.
await writeFile(
  path.join(repositoryRoot, 'apps/web/auth-config.js'),
  `window.GPUBNB_AUTH_CONFIG=${JSON.stringify(config)};\n`,
  { mode: 0o600 },
);
await writeFile(
  path.join(repositoryRoot, 'apps/web/config.js'),
  `window.GPUBNB_API_URL=${JSON.stringify(apiUrl)};window.GPUBNB_CONFIG={apiBase:window.GPUBNB_API_URL};\n`,
  { mode: 0o600 },
);
