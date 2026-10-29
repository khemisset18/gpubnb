# Core dependency remediation — actual validation

Status: npm remediation locally proven; full-repository Trivy gate BLOCKED;
CI integration/Agent/Contract results pending. Not production qualification.

The owner explicitly authorized applying/testing necessary Core dependency and
validation fixes on PR #313, without merge, deployment or financial activation.
The proposal retained in the preceding review is now applied to the actual root
and API trees. No audit-fix force command was used.

## Changes and compatibility

| Dependency | Before (both lockfiles) | After |
| --- | --- | --- |
| fastify | 5.12.1 | 5.12.7 (manifest floor ^5.12.5) |
| zod | 3.25.76 | 4.6.7 |
| brace-expansion override | 5.0.9 | 5.0.12 |
| fast-uri / AJV override | 3.1.7 | 3.1.9 |
| fast-json-stringify nested fast-uri | 4.1.4 | 4.2.3 |
| jayson override | 4.3.0 | 5.0.0 |
| @solana/web3.js | 1.98.4 | 1.98.4 (unchanged) |

Complete changes/removals are in `evidence/security-validation-20261029/dependency-changes.json`.
Jayson 5 removes vulnerable stream-json and its obsolete transitives. The
actual Solana client passes concurrent out-of-order JSON-RPC success, unique
request ID and JSON-RPC error propagation checks through a stub fetch with no
network connection. Existing PDA/digest/signature tests also pass.

All actual Zod schema uses were inventoried. Diagnostics' one-argument record
was changed to the explicit string-key form. Other records already specify
keys and values. Defaults are valid output types; no default-then-optional
pattern was found. Coercion, integer bounds, enum defaults, optionals, scalar
record rejection, exact paths and `.issues` handling remain enforced. The old
English-message telemetry assertion was replaced by stronger checks of error
class, issue code, path, bound and inclusivity, plus accepted boundary values.
The server's existing `.issues` response mapping remains unchanged. Fastify's
async schema-body regression is tested with actual `inject()`.

## Results on modified files

- Official Node 22.23.4 archive SHA-256 verified against Node SHASUMS256.
- Actual `npm ci` root and API: exit 0, scripts enabled.
- Actual `npm audit --json` root and API: exit 0; all severities zero.
- API `npm run build`, then `npx tsc -p tsconfig.json --noEmit`: exit 0.
- Targeted API suite: 37 tests pass, zero fail/skip, including five new regression tests.
- Asset Exchange: 150 pass, zero fail/skip. D0: 31 pass. Offline D1: 10 pass.
- Actual Trivy 0.76.1 `fs --scanners vuln` on modified checkout, all severities,
  no ignore-unfixed: npm lockfiles zero findings; repository nine occurrences
  (six MEDIUM, three LOW), zero HIGH/CRITICAL. Scanner exit 0 is report creation,
  **not** a clean qualification. CI now gates every reported vulnerability.

## Remaining Trivy blockers

| Location | Package | Advisory | Fixed version reported |
| --- | --- | --- | --- |
| Cargo.lock | borsh 0.10.4 | GHSA-fjx5-qpf4-xjf2 | 1.0.0-alpha.1 |
| Cargo.lock | glib 0.18.5 | GHSA-wrw7-89jp-8q8g | 0.20.0 |
| Cargo.lock | rand 0.7.3 | GHSA-cq8v-f236-94qc | 0.8.6 / 0.9.3 / 0.10.1 |
| requirements.txt + agent/requirements.txt | PyNaCl 1.5.0 | CVE-2025-69277 | 1.6.2 |
| services/control-gateway/Cargo.lock | rustls 0.23.43 | GHSA-2mjx-qc3c-rqvc | 0.23.45 |
| same | same | GHSA-c8m5-c952-6cm4 | 0.23.46 |
| same | same | GHSA-h2v8-394m-p7vv | 0.23.46 |
| same | same | GHSA-w44r-93j7-qv28 | 0.23.46 |

These are not suppressed or assessed as safe by this work. The scoped npm patch
does not modify the Rust/desktop/Agent cryptographic dependency trees. A full
repository security PASS remains blocked until those upgrades are separately
implemented and validated, including cryptographic/contract compatibility.

## CI evidence boundary

CI requires actual PostgreSQL and Redis readiness before API tests, uses both
actual npm trees with Node 22, audits all severities, retains successful and
failed API/Agent/Contract logs and the full Trivy report. Existing optional S3
tests require their own object store fixture; any skips must be reported
explicitly, never counted as tested integrations. Local sandbox cannot run
PostgreSQL/Redis or sudo namespaces; no local integration/D1 success is claimed.

No financial algorithm, signing routine, access control, production guard, D0
trust input, signature or acceptance identity was changed. CI was strengthened.
No merge/deployment or funds operation is authorized or performed.
