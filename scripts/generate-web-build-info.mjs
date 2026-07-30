import { readFile, writeFile } from 'node:fs/promises';

const configPath = new URL('../apps/web/config.js', import.meta.url);
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const value = {
  version: packageJson.version,
  commit: (process.env.COMMIT_REF || process.env.GITHUB_SHA || 'local').slice(0, 7),
  environment: process.env.CONTEXT || process.env.GPUBNB_ENVIRONMENT || 'development',
  date: new Date().toISOString(),
};
const source = await readFile(configPath, 'utf8');
const updated = source.replace(
  /window\.GPUBNB_BUILD = window\.GPUBNB_BUILD \|\| \{[\s\S]*?\n\};/,
  `window.GPUBNB_BUILD = window.GPUBNB_BUILD || ${JSON.stringify(value, null, 2)};`,
);
if (updated === source) throw new Error('build_info_marker_not_found');
await writeFile(configPath, updated, 'utf8');
