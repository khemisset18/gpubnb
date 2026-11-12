# Litecoin L0 public signing-key trust ledger

Status: OBSERVED / CRYPTOGRAPHIC PARTIAL ONLY / NO IDENTITY APPROVAL.
Profile: `LTC_BASECHAIN_TRANSPARENT_V1`.
Reviewed: 2026-11-12. PR #359.

## Public trust roots and separation of claims

| Signer / purpose | Pinned full OpenPGP fingerprint | Distribution | Evidence |
|---|---|---|---|
| David Burkett — tag and release manifest | `D35621D53A1CC6A3456758D03620E9D387E55666` | Signed upstream `SECURITY.md` declaration and official release HTTPS host; NOT out-of-band validated | Official source tag, `SHA256SUMS.asc`, Gitian assertion all pass cryptographic verification under updated release certificate |
| Loshan T — Gitian Linux assertion | `C0921846FED0BF4CF28BE1D73B2A6315CD51A673` | Litecoin upstream `SECURITY.md` plus source archived PGP certificate, and additional certificate from `keys.openpgp.org` | Expired official archive key correctly rejected. New public certificate from keyserver GPG-validates the detached builder assertion |

The above public channels and matching fingerprints **cannot replace**
verified out-of-band identity proof (operator-signed assertion, direct
keyholder confirmation over a trusted second channel or equivalent formal
trust process). The GitHub `unknown_key` flag does not override independent
GPG verification, and is not itself a fraud finding.

## Exact reviewed input hashes and replay context

- Source Gitian claims repository: `257e8c5e128c40091b9fcd0f7d2327587d04742d`.
- Source Litecoin commit: `ec1b6489a900d09cf5991e220dce089c77a232a2`.
- Signed David assertion SHA-256:
  `ea3845019223ba70a4159d2fdf71d2632722ef7c2f20dfe54a71676d90d9505c`.
- David detached signature SHA-256:
  `c40b5481c4dd781adfce30fd0f0b783e4ab492e5b08f18000df284b3f6447e46`.
- David release key SHA-256:
  `72151da0ab796aec3393ec8834d3ae2a12f6d37e07947357a5d59ad2caa1d7da`.
- Signed Loshan assertion SHA-256:
  `55fcfb4eb8f979c61ed62755ea5f813926a48aacdc2f75984790066f30c496a8`.
- Loshan detached signature SHA-256:
  `54e01cd63aeeed7ce0790a8b24c0f63005fd6508f6e0c586db5ed6326004378c`.
- Loshan archived official PGP certificate SHA-256 (expired at
  verification time): `58b4e3e1ba2d3b6c5df991c34f2249fe112fad085eaeb0f9f0ddabbc7faf0300`.
- Loshan observed keyserver certificate SHA-256:
  `027f0165865fcbcc53e3d09ee80251cca7da7a29b198fb31ea5b2c357bbbc3bf`.
- Binary SHA256: `43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9`.
- Upstream tag object SHA-1: `ee2aea3fc3fd95213d1a041d561b52e07ae6dc63`.

## Positive and negative evidence (exact SHA)

On `bc84a3c5e6ede331e9cbffa6b9979d076d04b1cf`, the archived
Loshan key produced `KEYEXPIRED` and `EXPKEYSIG` and the strict
workflow refused the two-builder proof (run 43125164411).

On `965afdd3f8977d2570bbdd569f2c13374e9b6ed0`, the keyserver
candidate was downloaded, full fingerprint matched, five new signatures
were imported by GPG, and both builder signatures passed
`GOODSIG/VALIDSIG` without expiry/revocation rejections.
Evidence: https://github.com/khemisset18/gpubnb/actions/runs/43127645875
and artifact `13903636677` with ZIP SHA256
`c37d65254bcf46433cf6f097b8431d1e79cd42675c740633aa99f240a798c219`.

The workflow now pins **all seven downloaded public objects**, including
the fresh keyserver candidate: any changed bytes must be reviewed before
updating pins. No private signing keys were retrieved or imported.

## Remaining approval requirements

- Human identity/trust: independently authenticate each publisher/builder
  fingerprint outside the associated distribution servers, with a recorded
  operator, method and UTC timestamp.
- Build independence: truly reproduce the pinned Litecoin source and all
  nine output checksums with a separate, authorized immutable toolchain,
  and document builder independence and toolchain/dependency SBOM.
- Threat/audit: independent review, supply-chain and key renewal policy,
  retained signed evidence, risk decisions and L0 sign-off. A completed
  GPG check is not a production authorization.
- L0 remains BLOCKED; L1–L8 NOT_TESTED; L9 BLOCKED.
  `automaticSettlementSupported=false`,
  `supportStatus=MARKETPLACE_ONLY`, settlement route `null`.

No Litecoin node, Regtest, Mainnet, funds, wallet, RPC, transaction,
broadcast, merge or deployment occurred.
