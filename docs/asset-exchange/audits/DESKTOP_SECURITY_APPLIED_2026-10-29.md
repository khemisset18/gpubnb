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
