# LTC L0 — integrity and provenance, not a runtime adapter

**State: PREPARATION / BLOCKED / NO FINANCIAL EXECUTION.** This resumes the
pre-existing `docs/asset-exchange/LITECOIN_ADAPTER_SPEC_V1.md`. It does
not start a node, construct a signed transaction, broadcast, create wallets,
install programs or activate a Litecoin settlement direction.

## Official candidate and independent observations

- Upstream project: https://github.com/litecoin-project/litecoin
- Reviewed release: https://github.com/litecoin-project/litecoin/releases/tag/v0.21.5.8
- Version: `v0.21.5.8`, published 2026-09-12.
- **Annotated tag object**: `ee2aea3fc3fd95213d1a041d561b52e07ae6dc63`.
- **Tagged source commit**: `ec1b6489a900d09cf5991e220dce089c77a232a2`.
- Official Linux x86_64 binary: `litecoin-0.21.5.8-x86_64-linux-gnu.tar.gz`.
- Published SHA-256: `43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9`.
- GitHub release asset size: `36,951,482` bytes.
- Signature asset: `SHA256SUMS.asc` (not bundled with this repository).

These are **published metadata pins**, NOT an independently established
trusted signer, reproducible build or qualified source. GitHub's tag API
reports signature `verified=false` / `unknown_key` for this annotated
tag. Treat that as **unverified**, not as evidence of invalidity or approval.
The official release includes material changes to MWEB consensus and
validation; Litecoin transparent-basechain settlement must explicitly
exclude MWEB and be qualified separately.

## Offline verification (an authorized operator later)

Obtain the exact release archive and the signed `SHA256SUMS.asc` from the
official release. Obtain a trusted **full 40-hex public signing fingerprint**
and its public key through independently verified channels, not from a
pasted hash in this repository. Import the approved public key into a
**dedicated** GPG keyring. The verifier only reads local files and never
fetches keys.

```bash
python3 asset-exchange/qualification/litecoin/l0/verify_release.py \
  --archive /private/read-only/litecoin-0.21.5.8-x86_64-linux-gnu.tar.gz \
  --signed-sums /private/read-only/SHA256SUMS.asc \
  --trusted-keyring /private/read-only/litecoin-release-verified.gpg \
  --trusted-fingerprint <40_HEX_CHARACTERS_FROM_INDEPENDENT_VERIFICATION>
```

This checks the archive's filename, fixed official size and bytes; decrypts
and verifies the signed checksum list using an isolated GPG home and only
the supplied keyring; requires a single valid GPG signature anchored to the
provided signer fingerprint; and requires the signed archive digest to equal
the official pinned digest. Failure is terminal. It does **not** extract or
run the binary and does **not** verify the signed source tag.

A successful result is still `L0_PARTIAL_BINARY_PROVENANCE_ONLY` with
`l0Qualified=false` and `settlementEnabled=false`.

## L0 / L1 blockers

1. Independently establish full signing-key fingerprint and verify the
   annotated source tag using its signature and exact tagged tree.
2. Obtain and verify the real release archive and signed sums against that
   independent trust root; optional locally reproduced source builds must
   be attributed to separate evidence.
3. Validate runtime toolchain, source/binary equivalence, pinned dependencies,
   isolated network/no outbound routing, genesis, chain name and RPC.
4. Explicitly exclude MWEB on every transparent funding, spend, wallet,
   signing and recovery path. No derivation from DOGE/Bitcoin defaults.
5. Establish immutable evidence and pass later L2-L9, with independent
   review before any settlement capability promotion.

## CI scope

Run the deliberately **offline** adversarial self-tests:

```bash
python3 -m unittest discover -s asset-exchange/qualification/litecoin/l0 -p 'test_*.py' -v
```

Unit tests use mock GPG output only to exercise failure logic. They are
**NOT cryptographic verification**, node execution or financial tests.
This slice adds no Litecoin wallet, network/RPC service, real keys, funds,
mainnet/testnet broadcast or deployment. DOGE and Core remain untouched.

## Source tag cryptographic guard (separate from binary guard)

`verify_tag.py` accepts **raw annotated tag object bytes**, e.g. obtained
from an already-cloned official source repository on a dedicated operator host:

```bash
git -C /private/litecoin cat-file tag v0.21.5.8 > /private/read-only/v0.21.5.8.tag
python3 asset-exchange/qualification/litecoin/l0/verify_tag.py \
  --tag-object /private/read-only/v0.21.5.8.tag \
  --trusted-keyring /private/read-only/trusted-public.gpg \
  --trusted-fingerprint <40_HEX_AUTHENTICATED_INDEPENDENTLY>
```

This checks the exact annotated Git object SHA-1
`ee2aea3fc3fd95213d1a041d561b52e07ae6dc63`,
its target commit, version tag, GPG detached signature and the **single**
signing fingerprint. GPG signature validity does not prove the signer identity.
Even success returns `L0_PARTIAL_SIGNED_TAG_ONLY` and
`l0Qualified=false`. No clone, fetch, key lookup or network connection is
performed by the verifier.

**Observed expiration blocker (2026-11-12):** the 3,159-byte archived
`contrib/gitian-keys/davidburkett38-key.pgp` key at v0.21.5.8 has
fingerprint `D35621D53A1CC6A3456758D03620E9D387E55666`, but its
expiration is **2022-04-26**. The authentic annotated tag object was
reconstructed using official GitHub API tag data (object SHA-1 matched).
GnuPG reports `VALIDSIG` **and** `KEYEXPIRED` / `EXPKEYSIG`
under the archived key for the 2026-09-09 tag; the CLI may return exit 0,
but our verifier must reject those status codes.

The official release directory lists a separate **5,560-byte** key file,
which may contain a renewed certification; this has NOT been downloaded
and its public-key status is NOT verified. A key from that directory
must be fingerprint-checked and independently authenticated before any
trust decision. Do not bypass expiry checks. See
`docs/asset-exchange/LTC_EVIDENCE_INDEX.md`.
