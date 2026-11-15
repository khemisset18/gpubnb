# Stage 4 — choosing an approved Windows code-signing path (decision record, 2026-11-15)

**Status: DECISION REQUIRED — NO-GO for a physical install. No existing host keys, trust stores or binaries modified.**

## Why simply applying a new certificate will fail

At PR #333 SHA `23a7a2950ecf365866f3531ddbf76920d9fcb295`:

- `scripts/verify-stage4-private-qualification.ps1` checks an exact `ExpectedPublisherSha256` and Authenticode `Valid`, requires the signer subject to contain `LOCAL PHYSICAL TEST ONLY`, **and rejects a TimeStamperCertificate**. This private-qualification verifier is **not** a general/public CA-signed release verifier.
- `scripts/new-stage4-private-qualification-package.ps1` selects the exact local test signer in `CurrentUser\\My`, issues four private test signatures, and emits a manifest requiring `installationReviewRequired=true`; it does not install.
- Embedded Agent/Helper/Worker/media publisher pins and the four-file manifest identities bind the signing identity to the build. Merely re-signing an existing PE file produces different bytes/hashes and can invalidate build identities/pins. A new approved release needs a build/sign/verify provenance chain end-to-end.
- `scripts/stage4-private-install-readiness.ps1` still requires the old backup **and live files** to have valid, nonexpiring Authenticode signatures and a valid *machine* signer chain. All four historical signatures were reported expired on PC1; simply approving a new signer cannot satisfy the old backup check.
- A scratch-only copy-restore check is not a physical rollback proof, and `X509Chain(true)` is not an actual `LocalSystem` runtime verification.

## Current PC1 identity inventory (operator-reported)

- `GPUbnb LOCAL PHYSICAL TEST ONLY 2026-11-14`, private signing key in `CurrentUser\\My`, expires 2026-12-14, **machine-chain-valid=false**.
- `WDKTestCert`, private signing key in `CurrentUser\\My`, expires 2036-09-22, **machine-chain-valid=false**. It is a development driver signer, **not** a substitute for an authorized application publisher.
- No already machine-trusted signing identity identified by this limited inventory; do not silently change `LocalMachine\\Root`, `LocalMachine\\TrustedPublisher`, disable signature enforcement, or export a private key.

## Supported paths to investigate (do not enroll or spend without user choice)

**A. Legally registered eligible organization in the EU:** investigate Microsoft Azure Artifact Signing **Public Trust** (formerly Trusted Signing). Microsoft documentation says organizations in the EU are eligible; Public Trust individual developers are currently limited to the United States and Canada. An Azure subscription, identity verification, account/profile configuration, and later a signed verification flow are required. Public Trust is distinct from **Private Trust** (which is not automatically Windows trusted). Microsoft documentation: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart and https://learn.microsoft.com/en-us/azure/artifact-signing/concept-trust-models.

**B. An individual in France or ineligible for Azure Public Trust:** evaluate a commercial publicly trusted code-signing certificate/service from a recognized CA, with independent identity/eligibility checks and protected signing key requirements. Do not claim an OV certificate can necessarily be issued to an individual or assume a vendor will approve a specific application. Microsoft review: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options.

**C. No trusted signer yet:** software CI, synthetic fault testing, provenance and offline scratch audit can proceed, but **physical PC1 installation remains NO-GO**.

## Verified external provider options (research only; no order)

Public documentation consulted on 2026-11-15:

1. **Certum Standard Code Signing**: Certum explicitly says Standard is available to an **individual or a company** and the signer displays personal name or business name; published entry pricing from **EUR 139** (electronic code/activation only, may require existing crypto card/reader), physical set from **EUR 169**, and cloud service from **EUR 209**. These are advertised starting prices, **not all-in quotes**. Confirm eligibility for a French resident, currently supported issuance path, identity-verification prerequisites and full cloud/key-storage fees *before any order*. Sources: https://www.certum.eu/en/code-signing-certificates/ and https://shop.certum.eu/code-signing.html
2. **SSL.com Individual Validation (IV) Code Signing**: expressly designed for individuals without a registered business; advertised entry price **USD 129/year**, with a separate HSM/token or eSigner subscription, and government-ID identity verification. Signer displays the verified **personal** name. Verify France eligibility and the full price before placing any order. Source: https://www.ssl.com/products/software-integrity/code-signing/iv/
3. **Microsoft Azure Artifact Signing Public Trust**: **not currently accessible for France-based individuals**. Microsoft lists Public Trust organizations in the EU but limits **individuals** to USA and Canada. Azure **Private Trust** does not meet the trust objective. Source: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
4. **SignPath Foundation free OSS signing**: only for projects meeting its requirements: OSI-approved license for all components, no proprietary components or commercial dual licensing, existing released project, maintained and documented. The public `khemisset18/gpubnb` GitHub repository does **not** list a top-level `LICENSE` at the observed PR source commit, and the project is a GPU rental marketplace. **Eligibility has not been demonstrated**. Do not silently add an OSS license or promise signing approval. Source: https://signpath.org/terms
5. **Certum Open Source Code Signing**: offered specifically for qualifying individual open-source developers, **not commercial software**; Certum states commercial distribution can cause revocation. Do not select for GPUbnb's planned paid/rental model without written confirmation of eligibility. Source: https://support.certum.eu/en/code-signing-required-documents/

**Practical provisional preference:** Certum Standard for a French individual intending commercial Windows code signing; SSL.com IV as an alternative. Neither has been ordered or issued; no actual PC1 trust is attested. Public CA signature alone does not complete Stage 4: pinned signer/build identities, independently qualified recovery release, runtime LocalSystem verification, backend compatibility, quarantine and physical testing remain separate gates.

## Design changes required before signing the last Stage 4 release

1. Add a **separately named signed-release policy** instead of weakening the private `LOCAL PHYSICAL TEST ONLY` verifier. Explicitly define approved public CA trust, certificate EKU, revocation/timestamp semantics, identities, and subject matching. A pinned certificate fingerprint can change upon public-signing credential rotation; independently specify approved issuer/publisher binding and release-specific pins; no runtime weakening.
2. Compile from a separately authenticated exact commit, generate consistent embedded worker/media signer policies and all four binaries, then sign using the approved service/CA with documented timestamp checks. Recalculate **all four signed hashes** and issue a new independently pinned manifest. Preserve the existing private test candidate separately.
3. Build a **separate signed recovery release** from authenticated source, not historical expired binaries. Require complete compatibility with the chosen cutover and host service. Record provenance, independent signature checks, issuer, expiring keys and ACL/NTFS policy.
4. Model the expired originals as `HISTORICAL_EVIDENCE_ONLY` for inspection; never count them as a valid rollback path. New cutover policy requires a tested signed rescue image and fail-closed transaction recovery that **never removes old live files or backups before independent recovery succeeds**.
5. Run adversarial tests for expired/unsigned/revoked/wrong-issuer/wrong-pin/rotated certificates; wrong timestamp; hash drift after signing; wrong backend version; process-topology mismatch; partial file swap, service startup failure, wrong/changed ACL, bad recovery manifest, and abort-before-stop.
6. Later, after separately reviewed explicit physical operator authorization, prove the actual `LocalSystem` chain/service runtime and rollback on an isolated authorized host window. This requires one exact nonquarantined GPU and renter console, backend release alignment, safe cleanup and physical 300-second browser-only test. No automatic host mutation, Render deployment, PR merge or quarantine change.

## Immediate decision needed

Is GPUbnb a legally registered company/organization that can pass EU organization identity validation, or an individual project? That determines the likely certificate-provider route. **A project name is not proof of legal organization.** No public-trust enrollment or purchase should be made without explicit user approval.

**Status: documentation only. No signing, installation or service/host action occurred.**
