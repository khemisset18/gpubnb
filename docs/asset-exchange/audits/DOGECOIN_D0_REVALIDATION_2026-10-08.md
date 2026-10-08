# Dogecoin D0 Revalidation Evidence — 2026-10-08

Status: D0 BLOCKED / NO BINARY EXECUTION / NO AUTOMATIC SETTLEMENT / NO MAINNET

## Scope

This evidence record captures the Dogecoin release-integrity stop reached during the resumed gpu.k.p2p qualification campaign.

It does not qualify Dogecoin settlement and does not authorize Mainnet, testnet broadcast, real funds, or registry promotion.

Pinned upstream source baseline:

- repository: `dogecoin/dogecoin`;
- release: `v1.14.9`;
- release commit: `e0a1c157791544e818c901bd9341896965afbf9d`;
- release date encoded by the upstream release commit: 2024-12-01.

## Evidence observed

The downloaded Linux release archive SHA-256 was:

`4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8`

The qualification run reported that this hash matches:

- the upstream `SHA256SUMS.asc` entry;
- the v1.14.9 Linux Gitian manifest attributed to `slightlyskepticalpotat`;
- the v1.14.9 Linux Gitian manifest attributed to `KunNw0n`.

This establishes checksum consistency, not trusted signer provenance.

## Provenance blockers

The qualification run reported:

- checksum signature key `DC6EF4A8BF9F1B1E4DE1EE522D3A345B98D0DC1F` expired on 2024-07-16, before the reported checksum signature date 2024-12-01;
- Gitian signer key `48C7B3FCBB060C957E5E468F38198FBB972B765A` is revoked with a 2020-03-15 revocation date;
- Gitian signer key `7E453C9D37AC2EB246645C4B75055E4030051C37` was not authenticated from the reviewed upstream release-key material/key service;
- the current upstream security policy names Dogecoin Core 1.14.7 as supported while the upstream release metadata identifies 1.14.9 as the current release.

The v1.14.9 prebuilt binary was therefore not executed.

## D0 decomposition

D0 is recorded as separate evidence gates so checksum agreement is not confused with signer trust.

### D0-A — Upstream source/release pin

Status: RESEARCHED / PINNED

Required identity:

- release `v1.14.9`;
- source commit `e0a1c157791544e818c901bd9341896965afbf9d`;
- build descriptors/configuration must be pinned before any internal build.

This is necessary but not sufficient for overall D0.

### D0-B — Prebuilt checksum consistency

Status: PASS UNDER OBSERVED EVIDENCE

The reviewed Linux archive hash agrees with the published checksum and two Gitian manifests.

This does not authenticate the signers.

### D0-C — Official prebuilt signer provenance

Status: BLOCKED

The currently reviewed signature/key evidence does not satisfy gpu.k.p2p's release-integrity policy.

Do not execute or qualify the upstream prebuilt artifact while this gate is blocked.

### D0-D — Upstream support-status consistency

Status: UNRESOLVED

The upstream repository currently exposes a support-policy discrepancy between the security policy and release metadata.

Treat this as governance/maintenance uncertainty, not as proof of a binary compromise.

### D0-E — Internal reproducible build

Status: PENDING EXECUTION

Permitted next step:

1. build from the pinned upstream source commit in an isolated environment;
2. pin build dependencies/toolchain and build descriptors;
3. produce two independent deterministic builds where feasible;
4. compare outputs with each other and with published manifests/hashes;
5. generate an internal SBOM and source-binding manifest;
6. generate gpu.k.p2p-controlled provenance/attestation;
7. document any byte differences before executing the result.

An internally reproduced artifact does not make D0 PASS automatically. The trust policy for accepting that artifact must be explicit and reviewed.

## Stop condition

Overall Dogecoin D0 remains BLOCKED.

Therefore:

- do not execute the questionable upstream prebuilt binary;
- do not start D1-D9;
- do not activate Dogecoin settlement;
- keep `supportStatus = MARKETPLACE_ONLY`;
- keep `automaticSettlementSupported = false`;
- keep settlement route null;
- do not proceed to BCH while strict STOP-ON-RED ordering remains in force.

## Required follow-up evidence

Before D0 can be reconsidered, record:

- exact build host/container identity;
- compiler/toolchain versions and hashes;
- source tree hash;
- Gitian/build descriptor hashes;
- dependency hashes;
- deterministic build outputs;
- comparison against published artifacts/manifests;
- internal SBOM;
- internal provenance/attestation;
- residual trust assumptions;
- explicit reviewer decision.

No evidence in this document authorizes Mainnet or real funds.
