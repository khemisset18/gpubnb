# Desktop security proposal — not applied

**PRÉPARÉ SANS EXÉCUTION IN THE ACTIVE DESKTOP TREE.** The owner explicitly limited
Core approval and requested a separate proposal for desktop scope extensions.
No file in apps/host-desktop is changed by this proposal.

Candidate: pin Vite 7.3.7 instead of 7.3.6 and override source-map-js 1.2.2
instead of resolved 1.2.1; regenerate only that package's lockfile. These are
the fixed versions identified by authoritative CI run 40894500362. The patch is
`evidence/desktop-security-proposal-20261029/desktop-security.proposed.patch`.

Tests on an isolated copy of the actual desktop source and the candidate
package files, with Node 22.23.4 / npm 10.9.9: actual npm ci PASS; npm audit all
severities zero; tsc --noEmit and actual Vite build PASS (11 modules). No desktop
native runtime, GUI, signing or wallet is executed. This is candidate validation,
not proof that the repository has been remediated. Actual repository Trivy stays
blocked by its unchanged desktop lockfile and three Rust graph findings.

Risks: dev-server/build dependency behavior may differ; frontend/native contract
and Windows preflight must run again after authorized application. Approval
requested is limited to these two package files, the reviewed override and
those checks on the draft PR; it grants no native/financial behavior change,
merge, deployment or chain execution.

## Additional targeted diagnostic — not a blanket PASS

The fixed source-map-js candidate rejects six malformed/extreme/nested indexed
map offsets within a bounded worker (three-second limit). A strict functional
check of a valid indexed map at generated column zero then FAILED (null source),
and flattening that map also fails. The official npm 1.2.1 baseline, downloaded
with its registry integrity verified, exhibits the same two defects; flat map
lookup works in both. These are recorded pre-existing indexed-map limitations,
not evidence of a new 1.2.2 regression. They have not been waived or repaired.
The strict diagnostic retains exit 1 and an explicit failure result alongside
its passed malformed-offset stage. Standard desktop build and audit still pass
on the isolated candidate; that does not establish complete desktop validation.
Windows editor-path vulnerability cases and native integration require their
actual platform checks after separate authorization. No desktop file is applied.
