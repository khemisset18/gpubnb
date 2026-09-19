import fs from 'node:fs';
import zlib from 'node:zlib';

const [, , outputPath = 'npm-audit.json'] = process.argv;
const registry = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

function packageName(pathname, entry) {
  if (typeof entry?.name === 'string' && entry.name) return entry.name;
  const marker = 'node_modules/';
  const index = pathname.lastIndexOf(marker);
  if (index < 0) return null;
  const tail = pathname.slice(index + marker.length);
  if (!tail) return null;
  if (tail.startsWith('@')) {
    const parts = tail.split('/');
    return parts.length >= 2 ? parts.slice(0, 2).join('/') : null;
  }
  return tail.split('/')[0] || null;
}

const versionsByPackage = new Map();
for (const [pathname, entry] of Object.entries(lock.packages || {})) {
  if (!pathname || !entry || typeof entry.version !== 'string') continue;
  const name = packageName(pathname, entry);
  if (!name) continue;
  const versions = versionsByPackage.get(name) || new Set();
  versions.add(entry.version);
  versionsByPackage.set(name, versions);
}

if (versionsByPackage.size === 0) {
  throw new Error('npm_bulk_audit_empty_lock_graph');
}

const payload = Object.fromEntries(
  [...versionsByPackage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, versions]) => [name, [...versions].sort()]),
);

async function requestAdvisories() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(registry, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'accept-encoding': 'identity',
          'user-agent': 'gpubnb-ci-npm-bulk-audit/1',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const raw = Buffer.from(await response.arrayBuffer());
      if (!response.ok) {
        throw new Error(`npm_bulk_audit_http_${response.status}`);
      }
      const body = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b
        ? zlib.gunzipSync(raw)
        : raw;
      return JSON.parse(body.toString('utf8'));
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('npm_bulk_audit_failed');
}

let advisories;
try {
  advisories = await requestAdvisories();
} catch (error) {
  const report = {
    ok: false,
    error: 'audit_service_unavailable',
    detail: error instanceof Error ? error.message : 'unknown',
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.error(JSON.stringify(report));
  process.exit(2);
}

const all = [];
for (const [name, entries] of Object.entries(advisories || {})) {
  if (!Array.isArray(entries)) continue;
  for (const advisory of entries) {
    if (!advisory || typeof advisory !== 'object') continue;
    all.push({
      name,
      id: advisory.id ?? null,
      severity: String(advisory.severity || 'unknown').toLowerCase(),
      title: advisory.title ?? null,
      url: advisory.url ?? null,
      vulnerableVersions: advisory.vulnerable_versions ?? null,
    });
  }
}

const blocking = all.filter(item => item.severity === 'high' || item.severity === 'critical');
const report = {
  ok: blocking.length === 0,
  packageCount: versionsByPackage.size,
  advisoryCount: all.length,
  blockingCount: blocking.length,
  blocking,
};
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

if (blocking.length > 0) process.exit(1);
