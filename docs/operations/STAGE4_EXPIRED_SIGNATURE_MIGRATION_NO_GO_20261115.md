# Stage 4 — expired-signature cutover and rollback requalification (DESIGN ONLY)

**Status: NO-GO. Proposal for review, not a migration authorization.** Based on PR #333 source commit `23a7a2950ecf365866f3531ddbf76920d9fcb295`. This document introduces **no installer**, no new trust exception, and no commands to change PC1.

## Observed condition (operator-provided, not independently audited on the host)

On 2026-11-15 the operator reported:

- A four-component candidate at the exact PR #333 source SHA: all four hashes matched a pinned manifest and signatures were `Valid` in the operator's **CurrentUser** context. Candidate manifest SHA-256: `559f2c475ea7dcf92b25687290157e25c3b6e764e0da91dc1e4145f26f31600e`. Candidate signer certificate SHA-256: `d16110d7bf758b416ce3c874974bd862038570348dc1ebb02b4b5a1a176cb218`; expires 2026-12-14.
- Installed old component files, an exact-byte November 15 backup and two older backups: old signer expired 2026-11-13; each of four files is now `UnknownError` in Authenticode; no timestamp. Most recent backup manifest SHA-256: `f8b4bed09e2124fd3b78feb3565f6d3ff9bbb880f57768db7b9be4ebb0ab3cc6`. The four latest backup hashes match installed files and manifest; installed file and directory SDDL matched backup.
- New self-signed signer is found in `CurrentUser\\Root` and `CurrentUser\\TrustedPublisher`, **not** in `LocalMachine\\Root` or `LocalMachine\\TrustedPublisher`. `X509Chain(true)` with offline revocation and code-signing EKU returned `UntrustedRoot`. This is *not* an actual LocalSystem runtime result.
- An isolated Downloads-only byte exercise reported `scratchByteRoundtripPass=true`: four candidate files copied, then exact old backup bytes restored and re-hashed. It explicitly reported `scratchAclReconstructionProven=false`, `originalServiceRollbackProven=false`, `installationAuthorized=false`.
- Earlier process observations showed two `gpubnb-agent.exe` instances in Session 0 (service-chain supervisor/child); the recovery wrapper currently requires exactly one agent in its post-start check. Resolve the intended topology rather than suppressing that check.
- Secure Boot was enabled. Neither Secure Boot nor byte-copy success proves an approved installation.

## Immediate preserve/stop rule

**Do not delete, uninstall, clean up, rename, or overwrite any old live component or any of the three known backups.** Expired signatures do not erase byte-level recovery evidence. Do not remove an old certificate simply because it expired. Do not run `-Apply`, `-Recover`, service stop/restart, or any Windows trust-store import as part of this proposal. No Render deployment, quarantine transition, booking enablement, or PC1→PC2 streaming.

The transactional engine already retains original `.old` files after a successful swap (see `STAGE4_PRIVATE_FOUR_FILE_PHYSICAL_MAINTENANCE_20261101.md`). Operator willingness to discard expired installations **does not replace an authorized, independently demonstrated rollback path**.

## Why the existing tools refuse the state

1. `scripts/stage4-private-install-readiness.ps1` check `old-backup-hashes-signatures-acls` verifies *both* backed-up and live originals have `Valid` Authenticode and >24 h certificate validity. The observed expired signer correctly fails.
2. `machine-context-publisher-chain` evaluates machine-context trust. An operator's CurrentUser trust does not prove machine/LocalSystem trust. The observed chain fails `UntrustedRoot`.
3. `scripts/stage4-private-offline-rollback-drill.ps1` requires **all six** readiness checks to pass before exercising a scratch restore. Its existing strict behavior must not be weakened just to make this historic test pass.
4. `scripts/stage4-private-four-file-transaction-core.ps1` demands the six verified checks before any physical service stop. The physical recovery wrapper also validates Authenticode post-start. Do not weaken either check.

## Proposed requalification path (requires a reviewed implementation and physical evidence)

### R1 — Preserve and identify the actual last-known-good release

- Freeze the original backup directory and manifest, record hashes/ACL/effective signature state and the exact running Agent identity without altering files. Keep an immutable separate copy under operator control, with integrity/access review.
- Independently identify the old binaries' source commit and embedded protocol/worker/media signer constraints from authenticated build provenance, not merely filenames or a self-reported manifest.
- Determine if an **approved, reproducible unsigned source artifact** exists for a known-good rollback version. If not, mark `R1=BLOCKED` and do not manufacture an apparently trusted old release by re-signing an unknown executable.

### R2 — Produce a **separate** signed rollback candidate, never edit historical evidence

- Use an approved signed-release process from an independently verified source/build artifact. Rebuild and sign **all four compatible components together** (Agent, Helper, Worker, media DLL). Verify identity and embedded pins. Never mix old executable bytes with new-signing manifests or use the live directory as an input.
- Sign only with an explicitly approved code-signing identity and verify its chain under the actual intended Windows service trust policy. The existing private test certificate recognized only in CurrentUser is insufficient.
- Generate a *new* recovery manifest referencing complete source provenance, exact signed SHA-256s, signer SHA-256, machine/GPU scope, required service topology, backup source, ACL and expiry. Independently check it with a **reviewed recovery verifier**; keep separate from the existing production candidate verification.
- Any absence of a trusted issuer, key, reproducible build, or valid full compatibility check is a `NO-GO`. In particular, do not import a self-signed root into LocalMachine merely to make the chain green; the current runbook prohibits trust-store edits.

### R3 — Establish actual rollback behavior outside the live host first

- Tests on synthetic Windows fixtures must cover four-file complete commit, crash after each rename, failed service start, failed heartbeat, ACL/owner/inheritance mismatch, tampered and expired signing evidence, wrong signer, wrong hashes, and interrupted recovery. Tests must assert **no service stop before all fail-closed gates pass**.
- A Downloads scratch-byte restore is useful evidence only for file copying. It must **never** claim Program Files ACL inheritance, a successful physical recovery or actual LocalSystem trust.
- Validate real service process topology from approved design: observations show two Agent processes while one recovery proof expects exactly one. Do not assume the second is malicious or silently adjust the check.
- For a *later*, explicitly operator-approved controlled maintenance window, an independent witness and a recovery authority are required; the service start, signed runtime, fresh heartbeat, STOP cleanup and safe rollback to a known-good signature-valid recovery release must be tested. No such physical test has occurred here.

### R4 — Review the migration state machine, then implement a separate recovery lane

The currently signed old bytes must remain immutable evidence. A future code change **may** support a versioned `EXPIRED_HISTORICAL_BACKUP` state for *inventory only* while requiring a separately signed, independently verified and locally recoverable replacement release before any physical mutation. An expired original **must never be counted as a valid recovery image**, and one boolean supplied by an operator or report must not assert that recovery is viable.

The transaction must bind separate hashes of (a) old historical bytes, (b) new qualified candidate, (c) signed recoverable release and its provenance. Do not loosen `old-backup-hashes-signatures-acls` or simply set `localPreflightPassed=true`. Implement and adversarially test a new policy before introducing any service-mutating code.

### R5 — Required independent physical gates

Beyond R1–R4: actual LocalSystem signature/publisher trust proof, one authorized renter console, no unauthorized helper/worker, exact non-quarantined GPU UUID, independent backend release compatibility, signed owner cleanup authorization, full verified stop/health/recovery evidence, and the 300 s browser-only PC1→PC2 campaign from the console runbook. Until then, `installationAuthorized=false` and public booking remains off.

## Evidence/acceptance matrix

| Evidence | Status as of 2026-11-15 |
| --- | --- |
| New candidate 4/4 hash and CurrentUser signature | Operator-reported PASS |
| Historical backup 4/4 exact bytes and live SDDL | Operator-reported PASS |
| Temporary file-byte roundtrip | Operator-reported PASS (scratch ONLY) |
| Historical backup signature valid now | **FAIL** |
| Newly qualified signed recovery release | **NOT PRODUCED** |
| Machine-chain trust and actual LocalSystem trust | **FAIL / NOT TESTED** |
| Compatible service topology and healthy rollback | **NOT PROVEN** |
| Final six-check install readiness | **FAIL** |
| Backend/quarantine/renter/physical streaming | **NOT PROVEN** |
| Authority to remove old installations | **NO** — only after independent recovery and explicit separately reviewed cleanup |

## Review questions before any implementation

1. What source SHA and reproducible build produced the currently installed four old components, and can the project produce an authenticated unsigned build for a recovery release?
2. Which code-signing issuer/chain is approved for LocalSystem on PC1 **without modifying host trust stores**? Is another, already trusted signing identity required?
3. Is a two-process Agent supervisor/child tree the intended architecture? Adjust tests only against an authoritative runtime design.
4. Who independently approves the new versioned recovery lane and controlled physical test window? Which exact rollback service/start and witness evidence is mandatory?

**Until these are answered and evidenced, this remains a design-only NO-GO.** No deletes and no installation.
