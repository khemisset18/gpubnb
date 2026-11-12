# Litecoin L0 independently reproducible build — bounded qualification plan

Status: PREPARATION / BLOCKED / NO EXECUTION AUTHORIZATION.
Related specification: `LITECOIN_ADAPTER_SPEC_V1.md`.
Profile: `LTC_BASECHAIN_TRANSPARENT_V1`.

## Entry gates (all currently OPEN)

1. Independently establish and record the publisher and each builder's
   full 40-hex signing fingerprint via at least one verified out-of-band
   channel. A key hosted next to the release is **not** such a channel.
2. Confirm independently (out of band) that the Loshan key
   matching fingerprint `C0921846FED0BF4CF28BE1D73B2A6315CD51A673`
   belongs to the expected builder. The older official archive certificate
   triggered `KEYEXPIRED/EXPKEYSIG`; a separately hosted current certificate
   with SHA-256 `027f0165865fcbcc53e3d09ee80251cca7da7a29b198fb31ea5b2c357bbbc3bf` now validates both Gitian
   detached signatures (run 43127645875). Review its certification,
   revocation and expiration history. A keyserver does NOT authenticate
   the person or prove a genuinely independent source build.
3. Pin all toolchain dependencies, Gitian/Guix descriptors, source tree
   and container/VM image by immutable SHA/digest. Verify no secrets,
   production wallets, GPUbnb Core RPC/DB/Redis, DOGE paths, cloud
   metadata endpoints or Mainnet RPC can be reached.
4. Obtain a separately approved isolated build plan: operator identity,
   signed source and dependency inputs, controls on egress, limits on
   CPU/RAM/disk/time, rollback and redaction of artifacts.

## Candidate independently executed reproducible build (NOT RUN)

- Source: `litecoin-project/litecoin`, tag object
  `ee2aea3fc3fd95213d1a041d561b52e07ae6dc63`, commit
  `ec1b6489a900d09cf5991e220dce089c77a232a2`.
- Gitian claim repository pinned to
  `257e8c5e128c40091b9fcd0f7d2327587d04742d`.
- Target Linux archive:
  `litecoin-0.21.5.8-x86_64-linux-gnu.tar.gz`;
  published SHA-256:
  `43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9`.
- Use a dedicated disposable builder, never the host used for actual
  financial/signing/production work. Independently authenticate all
  dependency archives and compiler reproducibility inputs; record
  exact package versions, SBOM and deterministic environment variables.
- Rebuild exactly as the pinned Litecoin release descriptor specifies,
  under controlled egress, with no wallet launch or Litecoin network
  connection; capture output archive, full output manifest, build logs,
  toolchain metadata, source/submodule hash and failures.
- Compare every output SHA-256 byte-for-byte with signed reference
  manifests. A mismatch is BLOCKED, investigate provenance, never
  silently normalize or repack.
- Require a second genuinely independent builder/operator to repeat
  the experiment with separately controlled infrastructure, verify
  both signatures, and sign each evidence bundle with audited review.
  Two historical Gitian text files alone do NOT satisfy this requirement.

## Proof acceptance
The exact-code-SHA evidence record must identify operator/reviewer, UTC
timestamp, isolated VM or host digest, all builder binaries/compilers,
sources, signed input manifests, warnings, failure traces, artifact hashes
and results for each independent run. Sensitive credentials/keys must never
enter public CI logs or uploaded artifacts.

Do not mark L0 PASS until publisher trust, tag/manifest/archive signature,
independently reproduced builds, supply-chain/SBOM review and a separate
operator approval are complete. L1 Regtest identity testing requires a
separate permission. L2 MWEB isolation remains entirely NOT_TESTED.

Prohibited in this preparation: Mainnet, public broadcast, test funds,
mining, node/RPC, wallet/seed/private keys, live adapter code, automatic
settlement activation, merge and deployment.
