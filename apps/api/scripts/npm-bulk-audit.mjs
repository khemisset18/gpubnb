import fs from 'node:fs';
import zlib from 'node:zlib';

const [, , outputPath = 'npm-audit.json'] = process.argv;
const NPM_BULK_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns/';
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
if (versionsByPackage.size === 0) throw new Error('dependency_audit_empty_lock_graph');

const exactPackages = [...versionsByPackage.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .flatMap(([name, versions]) => [...versions].sort().map(version => ({name, version})));

const npmPayload = Object.fromEntries(
  [...versionsByPackage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, versions]) => [name, [...versions].sort()]),
);

async function requestJson(url, options, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {...options, signal: controller.signal});
      const raw = Buffer.from(await response.arrayBuffer());
      if (!response.ok) throw new Error(`${label}_http_${response.status}`);
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
  throw lastError instanceof Error ? lastError : new Error(`${label}_failed`);
}

function normalizedSeverity(value) {
  if (typeof value !== 'string') return null;
  const severity = value.trim().toLowerCase();
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'moderate' || severity === 'medium') return 'moderate';
  if (severity === 'low') return 'low';
  return null;
}

function npmAdvisories(report) {
  const items = [];
  for (const [name, entries] of Object.entries(report || {})) {
    if (!Array.isArray(entries)) continue;
    for (const advisory of entries) {
      if (!advisory || typeof advisory !== 'object') continue;
      items.push({
        source: 'npm',
        name,
        id: advisory.id ?? null,
        severity: normalizedSeverity(advisory.severity) || 'unknown',
        title: advisory.title ?? null,
        url: advisory.url ?? null,
        vulnerableVersions: advisory.vulnerable_versions ?? null,
      });
    }
  }
  return items;
}

function osvSeverity(vulnerability) {
  const candidates = [
    vulnerability?.database_specific?.severity,
    ...(Array.isArray(vulnerability?.affected)
      ? vulnerability.affected.flatMap(affected => [
          affected?.database_specific?.severity,
          affected?.ecosystem_specific?.severity,
        ])
      : []),
  ];
  for (const value of candidates) {
    const normalized = normalizedSeverity(value);
    if (normalized) return normalized;
  }
  return 'unknown';
}

async function osvAdvisories() {
  const queries = exactPackages.map(({name, version}) => ({
    version,
    package: {name, ecosystem: 'npm'},
  }));
  const batch = await requestJson(
    OSV_BATCH_URL,
    {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify({queries}),
    },
    'osv_batch',
  );
  if (!Array.isArray(batch?.results) || batch.results.length !== queries.length) {
    throw new Error('osv_batch_shape_invalid');
  }

  const affected = new Map();
  const record = (id, name, version) => {
    if (typeof id !== 'string' || !id) return;
    const packages = affected.get(id) || new Set();
    packages.add(`${name}@${version}`);
    affected.set(id, packages);
  };

  for (let index = 0; index < batch.results.length; index += 1) {
    const {name, version} = exactPackages[index];
    let result = batch.results[index] || {};
    for (const vuln of result.vulns || []) record(vuln?.id, name, version);

    let pageToken = result.next_page_token;
    while (typeof pageToken === 'string' && pageToken) {
      result = await requestJson(
        OSV_QUERY_URL,
        {
          method: 'POST',
          headers: {'content-type': 'application/json', accept: 'application/json'},
          body: JSON.stringify({
            version,
            package: {name, ecosystem: 'npm'},
            page_token: pageToken,
          }),
        },
        'osv_query',
      );
      for (const vuln of result.vulns || []) record(vuln?.id, name, version);
      pageToken = result.next_page_token;
    }
  }

  const ids = [...affected.keys()].sort();
  const details = [];
  for (let offset = 0; offset < ids.length; offset += 16) {
    const chunk = ids.slice(offset, offset + 16);
    const values = await Promise.all(chunk.map(id =>
      requestJson(
        OSV_VULN_URL + encodeURIComponent(id),
        {method: 'GET', headers: {accept: 'application/json'}},
        'osv_vuln',
      ),
    ));
    details.push(...values);
  }

  return details.map(vulnerability => ({
    source: 'osv',
    id: vulnerability.id ?? null,
    severity: osvSeverity(vulnerability),
    title: vulnerability.summary ?? null,
    aliases: Array.isArray(vulnerability.aliases) ? vulnerability.aliases.slice(0, 8) : [],
    packages: [...(affected.get(vulnerability.id) || [])].sort(),
  }));
}

let source = 'npm-bulk';
let advisories;
let primaryError = null;
try {
  advisories = npmAdvisories(await requestJson(
    NPM_BULK_URL,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-encoding': 'identity',
        'user-agent': 'gpubnb-ci-dependency-audit/2',
      },
      body: JSON.stringify(npmPayload),
    },
    'npm_bulk_audit',
  ));
} catch (error) {
  primaryError = error instanceof Error ? error.message : 'unknown';
  source = 'osv-fallback';
  try {
    advisories = await osvAdvisories();
  } catch (fallbackError) {
    const report = {
      ok: false,
      error: 'audit_services_unavailable',
      npm: primaryError,
      osv: fallbackError instanceof Error ? fallbackError.message : 'unknown',
    };
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
    console.error(JSON.stringify(report));
    process.exit(2);
  }
}

const blocking = advisories.filter(item =>
  item.severity === 'critical' || item.severity === 'high' || item.severity === 'unknown'
);
const report = {
  ok: blocking.length === 0,
  source,
  npmPrimaryError: primaryError,
  packageNameCount: versionsByPackage.size,
  exactPackageVersionCount: exactPackages.length,
  advisoryCount: advisories.length,
  blockingCount: blocking.length,
  blocking,
};
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

if (blocking.length > 0) process.exit(1);
