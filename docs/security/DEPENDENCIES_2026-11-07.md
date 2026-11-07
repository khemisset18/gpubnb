# Shared npm dependency correction — 2026-11-07

Base: PR #334, 1f0a098c06552d5e53ea091a2a85b7ce8cc876d2. Separate branch; no rental business logic or workflow modification.

Root audit before: 3 moderate findings through @fastify/static → glob → minimatch. Both locks contained glob 13.0.6 and minimatch 10.2.5. Updated @fastify/static within its existing allowed major range, letting the maintained parent select glob 14. No forced transitive override and no manually invented integrity values.

Primary advisories: https://github.com/advisories/GHSA-3g3m-2fjr-6pw4 (glob cancellation continuing filesystem traversal) and https://github.com/advisories/GHSA-g3hv-75wg-m249 (minimatch amplification). Root/API configuration registers static files with a fixed root; no direct attacker-selected glob was demonstrated. Installed affected versions justified remediation; remote exploitability is not claimed proven.

Resolved versions:

```json
{
  "package-lock.json": {
    "@fastify/static": "10.1.10",
    "glob": "14.0.4",
    "minimatch": "11.0.5",
    "content-disposition": "3.0.0",
    "@fastify/send": "4.2.1"
  },
  "apps/api/package-lock.json": {
    "@fastify/static": "10.1.10",
    "glob": "14.0.4",
    "minimatch": "11.0.5",
    "content-disposition": "3.0.0",
    "@fastify/send": "4.2.1"
  }
}
```

## Executed validation

| Check | Status | Result |
|---|---|---|
| Root npm lock audit after | PASS | 0 findings |
| API npm lock audit after | PASS | 0 findings |
| API npm ci --ignore-scripts | PASS | 207 packages |
| API build | PASS | Prisma generation and TypeScript compile |
| Static-serving integration | PASS | Real Fastify inject: body, HEAD, ETag/304, byte range/206, SPA fallback, API/internal 404, traversal rejection |
| npm test entry point | BLOCKED | tsx IPC socket EPERM in this environment |
| Same suite via node --import tsx --test --test-concurrency=1 | FAIL | 690 tests: 641 pass, 15 fail, 34 skipped |
| Production/GPU integration qualification | BLOCKED | No PostgreSQL/Redis services or full successful regression run |
| Rust advisory remediation | NOT_TESTED | Cargo.lock unchanged |

The alternative Node loader runs the actual existing test files without changing or suppressing them. Two test files fail import because DATABASE_URL is missing; 13 quarantine cases fail because PostgreSQL localhost:5432 is unavailable. Skipped cases retain their existing test guards. These are not reclassified as passing. A successful isolated PostgreSQL/Redis CI run remains required before merge. Node used locally: v24.22.1; CI targets 22.

content-disposition changes from 2.0.1 to 3.0.0 through the parent update and requires Node >=22, compatible with the declared project engine. API build and static HTTP behavior pass; exhaustive header compatibility is not asserted.

Changed production files: package-lock.json, apps/api/package-lock.json. Added test: apps/api/test/static-serving-security.test.ts. This report and evidence/2026-11-07 include original logs, audit JSON and SHA256SUMS. No security gate bypass, deployment, main/dev merge, mainnet or production data modification.
