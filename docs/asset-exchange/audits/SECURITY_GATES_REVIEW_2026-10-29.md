# Remaining security gates and Core boundary — 2026-10-29

Status: **CORE PATCH PROPOSED, NOT APPLIED / REAL SECURITY GATES STILL FAIL**.
The user's original absolute constraint says: "Aucune modification de `main`,
de GPUbnb Core ou des systèmes financiers de production." A later request to
continue does not explicitly lift that Core restriction or separately authorize
Dogecoin binary execution. This work therefore prepares concrete changes for
approval while leaving Core source/manifests/lockfiles untouched.

## Recovered blockers

CI run 40882498046 at `1e3006286a904c249e8914a28699e59cf3247a8c`:

| Downloaded report artifact | ID | Verified ZIP SHA-256 |
| --- | --- | --- |
| npm audit | 12900583572 | `5ad310796d0c4c2c19397f11e26a1461846e437539042223a14112fd43e45945` |
| Trivy filesystem | 12901860136 | `ec72b3a67c402f8cac997478ef406eaca7728e82a180e2049102ed1db57f8ae2` |

Trivy's HIGH findings concern Fastify and brace-expansion in **both** the root
and `apps/api/package-lock.json`. Fresh npm auditing also blocks on Zod and
reports moderate fast-uri/stream-json findings. No finding is ignored or
reclassified. The historical snapshot discovery matrix is a separate diagnostic:
the pinned candidate succeeds and seven alternatives are rejected. Its failure
has not been hidden, disabled or converted into qualification success.

## Concrete proposed Core patch

[`core-security-upgrade.proposed.patch`](evidence/security-review-20261029/core-security-upgrade.proposed.patch)
is an applicable, **unapplied** five-file patch. `git apply --check` passes.

| Component | Installed | Resolved candidate | Change |
| --- | --- | --- | --- |
| Fastify | 5.12.1 | 5.12.7 | dependency floor `^5.12.5`, same major |
| brace-expansion | 5.0.9 | 5.0.12 | existing override updated |
| fast-uri, AJV tree | 3.1.7 | 3.1.9 | same-major override |
| fast-uri, serializer tree | 4.1.4 | 4.2.3 | same-major override |
| Zod | 3.25.76 | 4.6.7 | major upgrade required by published advisory |
| Jayson | 4.3.0 | 5.0.0 | removes vulnerable stream-json dependency |

The proposal updates root/API manifests and their lockfiles, plus the known Zod
record compatibility call in `apps/api/src/machine-diagnostics-routes.ts`:
`z.record(z.unknown())` becomes `z.record(z.string(), z.unknown())`.
It does not import the old vulnerable `zod/v3` API, weaken schema checks, upgrade
the financial SDK wholesale, add vulnerability exceptions or alter audit gates.
Further compatibility fixes may be needed after authorized full Core testing.

Primary security/migration references:
- https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
- https://zod.dev/v4/changelog
- https://github.com/fastify/fastify/security/advisories/GHSA-667r-xxjv-c9mm
- https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-qhr7-859c-m2p7
- https://github.com/uhop/stream-json

## Validation actually performed

Only package/lockfile copies outside Core were changed for this proposal.
Fresh `npm audit --package-lock-only --audit-level=low --json` exits 0 on **both**
candidate lockfiles: zero low/moderate/high/critical advisories. Installation
integrity is recorded in those proposed lockfiles. Candidate dependencies were
installed with lifecycle scripts disabled for this dependency-only lab.

Synthetic checks on Node 24.22.1 / npm 11.9.0 pass:
- the oversized constrained Zod collection returns one issue;
- the proposed metrics record accepts normal records and rejects arrays;
- the existing Solana client performs a synthetic `getVersion` round trip with
  Jayson 5 through an injected fetch; **zero real network requests** occur.

The replay script, results, package versions and before/after npm summaries are
under [`evidence/security-review-20261029/`](evidence/security-review-20261029/).
These checks do **not** substitute for the Core API build, Node 22 tests,
PostgreSQL/Redis integration or an actual post-application Trivy run. Those are
mandatory after Core modification is explicitly authorized. Core CI remains
failed now; this proposal is not a green Core release.

## Work continued inside the authorized Asset Exchange boundary

D0 stays accepted solely through its proven source-rebuild route. The adapter
specification now records that result accurately, preserving the separate
upstream-prebuilt GPG blocker and all disabled capabilities.

An isolated D1 network-identity harness, ten offline tests and a manual-only
workflow are prepared. See
[`DOGECOIN_D1_ISOLATED_EXECUTION_PLAN.md`](../DOGECOIN_D1_ISOLATED_EXECUTION_PLAN.md).
No Dogecoin executable or D1-D9 node campaign has been run. No merge, trust-input
change, Core modification, Mainnet, real funds or settlement activation occurred.

Two distinct approvals are needed to continue beyond this review: the bounded
Core dependency/validation remediation, and execution of the prepared D1-only
isolated regtest phase. Neither approval would authorize merge or production.
