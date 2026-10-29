# DOGE D0: missing release tag in Gitian input

Historical diagnostic status: **BLOCKED pending corrected independent builds and attestations**.
The completed result is recorded in
[DOGECOIN_D0_REPRODUCTION_PASS_2026-10-29.md](DOGECOIN_D0_REPRODUCTION_PASS_2026-10-29.md).
This investigation executes no downloaded or rebuilt Dogecoin executable.
All changes remain on PR #312; no merge or financial activation is authorized.

## Primary evidence recovered

Run [40804945097](https://github.com/khemisset18/gpubnb/actions/runs/40804945097),
harness commit `460d6b812247f3434c6666c5aab649df06d2b91f`: both builds completed
compilation but failed the official archive hash gate. Comparison was skipped.
Their actual archives were recovered and compared locally as data.

| Evidence | SHA-256 |
| --- | --- |
| Replica A artifact ZIP 12872372105 | `18ddcea84bf599649611385be8e72920470164a58366a64e08b08e80e209ce44` |
| Replica B artifact ZIP 12871924917 | `2bdd264779c50e4d3d7f85b0f9414e2668d6d902286dde476fcab6aa2f956f5d` |
| Both actual replica archives (35,518,624 bytes) | `b0aab5a024db9e1c0df09df716581d41b543fd2fee92be9cef4a981a4130e1b7` |
| Official archive (35,518,706 bytes) | `4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8` |
| Both generated 323-package Focal manifests | `e4a9e093aae78456b18b4029d682cef2debfc97c1472314479a559520973f113` |
| Unmodified upstream Linux descriptor | `bcaa3155559ed89ebfd38ad02e8e42f2727fa1dc0db5b01ac5cfad0a46e055d7` |

ZIP hashes match GitHub Actions artifact metadata. The official archive was
downloaded from the official v1.14.9 release URL and matched the **existing**
pinned hash before inspection. This does not rehabilitate upstream GPG signer
provenance. Full Actions log retrieval still returned `Transport closed`;
complete Gitian logs and result YAMLs are in the verified ZIPs.

Both generated Focal manifests now byte-match the checked-in KunNw0n manifest.
Both actual replica archives byte-match each other. Thus the earlier package
cohort defect is repaired, but it did not explain the remaining output mismatch.

## Exact observed binary difference

All 20 tar member names, their order, types, sizes, timestamps, modes, ownership
and link metadata match the official archive. The headers, manpages and
`libdogecoinconsensus.so.0.0.0` payload match. The five executable payloads differ:

| File under `dogecoin-1.14.9/bin/` | Version string offset | Official | Failed replicas |
| --- | --- | --- | --- |
| dogecoin-cli | `0x29782e` | `v1.14.9` | `v1.14.9.0-e0a1c1577` |
| dogecoind | `0x805b8b` | `v1.14.9` | `v1.14.9.0-e0a1c1577` |
| dogecoin-qt | `0x1d5762b` | `v1.14.9` | `v1.14.9.0-e0a1c1577` |
| dogecoin-tx | `0x2d56ae` | `v1.14.9` | `v1.14.9.0-e0a1c1577` |
| test_dogecoin | `0xaf3a0e` | `v1.14.9` | `v1.14.9.0-e0a1c1577` |

Static ELF inspection also finds changed build IDs, debuglink CRCs and address
references. No executable was launched. These are real payload differences,
not merely different gzip headers or tar metadata.

The complete per-member metadata, hashes and version strings are retained in
`evidence/doge-d0-20261029/failed-archive-comparison.json`. Regenerate with:

```sh
python3 asset-exchange/qualification/dogecoin/d0/diagnose-archives.py \
  official.tar.gz replica-a.tar.gz replica-b.tar.gz > comparison.json
```

The diagnostic reads tar members in memory; it never extracts or executes
them. Its `DIAGNOSTIC_ONLY` output cannot qualify D0.

## Mechanism reproduced without running Dogecoin

The pinned Gitian builder's `bin/gbuild` initializes a new `inputs/dogecoin`
repository and fetches the supplied source SHA with `--no-tags`. The harness
supplies the immutable commit, so Gitian's special handling for a tag argument
does not apply. Tags in the separate source/descriptor checkout do not transfer
to this input repository.

At the existing source commit, upstream `share/genbuild.sh` uses `git describe
--abbrev=0` to emit `BUILD_DESC` when the current clean commit has a release tag;
otherwise it emits `BUILD_SUFFIX`. `src/clientversion.cpp` formats that suffix
as the observed longer version. This was reproduced using the actual upstream
script (SHA-256 `9cae11522344ba6183db75bd0da041718c9c614abd796d0bceaf9f0c0a47318e`):

```text
Same clean HEAD e0a1c157791544e818c901bd9341896965afbf9d, no tag:
#define BUILD_SUFFIX e0a1c1577
Same clean HEAD, original annotated v1.14.9 tag present:
#define BUILD_DESC "v1.14.9"
```

The original annotated tag object observed is
`3452f45621ef877666d145c34a97d6b1ac417869`; it peels to the existing source pin.
This object ID records an observation, not a new trusted signing key or source
authority. No tag, signature or upstream source file is manufactured or edited.

## Minimal correction and validation

Before compilation, prepare Gitian's actual input checkout with only the
original `refs/tags/v1.14.9`; require an annotated tag peeling to the **existing**
source commit, exact clean HEAD and exact `git describe` result. Generate a
diagnostic header with upstream `share/genbuild.sh` and require the official
release description. Retain the header and tag metadata in each build artifact.
Gitian still receives the same `--commit dogecoin=<pinned SHA>` and URL; its
normal subsequent SHA fetch preserves the prevalidated tag.

No snapshot, official hash/manifest, descriptor, source/builder commit, signing
key, trust policy or comparator acceptance rule changes. Tag metadata does not
select another source revision: a moved tag fails before compilation.

31 offline tests pass, including seven real Git-fetch regressions: reproduce
tag loss; retain the original tag across Gitian's SHA-only fetch; reject missing,
moved and lightweight tags; refuse an existing input directory; exclude other
tags. Real-upstream preparation and both upstream generated-header cases pass.
Bash syntax and `git diff --check` pass.

This proves the missing-tag defect and its version-generation effect. Only
corrected full builds matching the official hash can establish that it accounts
for the entire archive divergence. A successful local diagnostic or identical
non-official outputs are insufficient. SBOM, provenance and both required
attestations remain mandatory before any full D0 claim. Global CI security
failures remain unwaived; no D1-D9, Mainnet, funds or settlement activation.
