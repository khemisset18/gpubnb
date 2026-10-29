# Authorized desktop security correction — 29 October 2026

Owner approval in the attached expanded mission explicitly supersedes the
previous proposal-only desktop restriction. Work remains on draft PR #313;
no merge, deployment, production finance, D0 trust change or chain operation.

The actual desktop manifest and lock now pin Vite 7.3.7 and source-map-js 1.2.2.
Only these two package resolutions change; optional-platform libc metadata is
preserved. No new dependency, scanner exception or severity filter is added.

## Source-map compatibility repair

The historical failing diagnostic and baseline comparison in
`evidence/desktop-security-proposal-20261029/` remain untouched. The new fixed
npm package retained old indexed-map bugs: column-zero lookup, missing sourceRoot,
local first-line offset composition, nested reverse lookup, null sources/name
index zero, and known sources without embedded content. The explicit build-time
patch in `apps/host-desktop/tools/` corrects those cases in one consumer file.
It preserves the upstream denial-of-service offset/nesting guards.

The installer checks package version and exact original SHA-256, exact unique
replacement preimages and exact output SHA-256. Already-patched bytes are
accepted idempotently; any unknown bytes fail the installation. The upstream
package version is not falsified. The readable patch and BSD-3-Clause copyright,
conditions and disclaimer are checked in. npm ci applies the patch explicitly
through postinstall; Windows' existing ignore-scripts installation is followed
by an explicit prepare step. No unreviewed lifecycle script is newly enabled
in that Windows installation.

## Actual local validation

Evidence: `evidence/desktop-applied-20261029/`, with SHA256SUMS.
Node 22.23.4/npm10.9.9, actual npm ci and audit all severities: PASS/zero.
Strict TypeScript, actual production frontend and debug source-map builds: PASS.
Eleven targeted tests: PASS, zero fail/skip (ten on Windows, because the upstream
root-shadow issue is POSIX-only). These cover actual PostCSS use, nested/flat
round trips, missing contents, unmapped segments, malformed/extreme offsets in
a three-second worker, loopback HTTP filesystem boundaries, the upstream custom
middleware request shape, and safely isolated actual bundled Windows editor
helpers. No editor/command is launched by the helper tests. They do not replace
native Windows validation.

The unchanged historical strict diagnostic now reports PASS, including its six
malformed-offset assertions and valid indexed-map round trip. The entire upstream
Node test harness at b158388e8721f622ef3fc82b0b545c7146bfc203 passes 145/145
against the patched consumer; no upstream assertions are deleted or changed.
A separately documented URL-contract experiment records that the raw Vite HTML
API is not an arbitrary HTML-as-URL sanitizer; browser-encoded request vectors
and the actual upstream advisory shape are tested instead. This is no claim of
security for hypothetical custom middleware accepting raw HTML as a URL.

## Pending CI at publication

Linux native host integration and Windows frontend/native/installer checks are
required on this exact change. The global all-severity, development-inclusive,
unfixed-inclusive Trivy gate remains strict. Three existing Rust graph issues
remain expected; only a real report may establish the current count. No global
security or production qualification PASS is inferred from the local audit.

## First actual CI observations and follow-up

Run 40959885917, commit c8bdef493c140097c1cc198aa6ec67bdb58ca4d5:
Linux desktop dependency install/audit, eleven regressions, frontend/TypeScript
and native host contracts all PASS. The independently downloaded Trivy artifact
12935187185 has verified ZIP SHA-256
9b5e60f3c25ad77beb82ef387c71078d0c3b26b84a23e5b653fe4179452522ef.
Exactly three findings remain: borsh/glib MEDIUM and rand LOW. All six former
desktop findings are absent. The full original ZIP is preserved with this report.
The global gate remains correctly FAILED.

Windows run 40959885741 correctly FAILED: the permitted temporary fixture file
returned403 before any installer/native build. Its original full log is preserved
losslessly in gzip with a raw digest. The repair canonicalizes the Windows temp
path before constructing the narrow filesystem allowlist, addressing 8.3 vs long
path identities. The HTTP200 positive control and all HTTP403/security assertions
remain unchanged. A fresh Windows run must confirm this hypothesis.

Every frontend build now explicitly prepares the checked source-map patch,
including workflows which intentionally install with ignore-scripts. The readable
patch is rendered with zero context so its required unified-diff context prefixes
do not introduce whitespace-only lines into the unchanged strict P2P gate.
No installed patch bytes or assertions change in that formatting adjustment.

The next Windows run established that the canonical-path repair restored the
positive HTTP200 control. The outside-file request then returned404 because
Vite's Windows raw-fs middleware strips the requested drive letter and serves
from the checkout drive, while the OS temp directory was on another drive.
The second failed log is retained. Fixtures are now created privately on the
serving process drive, so the existing denied file actually exists at the
requested path. RequiredHTTP403 and sentinel-absence assertions remain strict.
The Windows result for that final fixture repair is still pending at this point.

P2P also correctly rejected redundant final blank lines in two new tool logs.
Their original bytes are now retained in deterministic gzip, with source-commit
and digest mapping; readable views remove exactly one final LF each. A new
regression independently pins both original hashes and checks exact recovery.
The historical assertions and results are unchanged.
