# New native DOGE AuxPoW boundaries

Base: PR357 at `dfc072becc46252c38b81dde25fcc302f40a52c0`, preserving PR354's eight native controls, PR356's fifteen fee cases and PR357's independent VM recovery. The earlier eight AuxPoW controls are not selected again.

Native status at preparation: **NOT_TESTED**. Software laboratory checks:37 PASS. Full D2–D9 and financial activation remain BLOCKED.

All source assumptions come from unmodified Dogecoin1.14.9 commit `e0a1c157791544e818c901bd9341896965afbf9d`. The builder adapts its official C++ unit tests and QA wire layout, reuses the existing SHA256/Scrypt helpers and preserves MIT attribution. Only native observations decide acceptance.

| New property | Expected layer | Prepared native expectation |
| --- | --- | --- |
| Parent transaction at Merkle index1 | Consensus | Reject despite coherent parent root/branch/work |
| Parent transaction without inputs | Consensus | Reject gracefully before accessing input0 |
| Duplicate merged-mining headers | Consensus | Reject duplicate marker |
| Header separated from committed root | Consensus | Reject misplaced marker |
| Legacy root at byte21 without marker | Consensus | Reject beyond20-byte boundary |
| Commitment nonce truncated | Consensus | Reject incomplete commitment |
| Serialized parent header truncated | RPC deserialization | Exact end-of-data error; unchanged tip |
| Noncanonical CompactSize parent branch count | RPC deserialization | Exact noncanonical-read error; unchanged tip |
| Legacy root exactly at byte20 | Consensus | Accept boundary |
| Chain Merkle branch length30 | Consensus | Accept with exact uint32 index |
| Parent Merkle branch length31 | Consensus | Accept;30 cap applies to chain branch |
| Extra bytes after valid RPC proof | RPC normalization | Ignore suffix; accept normalized proof |

The suffix case does not claim that trailing bytes belong to a valid serialized consensus block. Pinned `AuxMiningSubmitBlock` reads `CAuxPow` without requiring the RPC stream to be empty. Malformed/truncated encodings must instead fail before consensus. The layers are recorded separately.

Each negative property is submitted on each node's registered template, retaining exact proof hashes, native reasons and unchanged tips. Four valid boundaries are accepted on A and decoded independently on B. The first reuses the child template of the negative inputs, checking cache integrity. The final three boundary blocks are reorganized out by a longer four-block native AuxPoW branch. Both nodes must converge and mark those blocks orphaned. The temporary local rollback used to prepare B is reconsidered before peering.

To avoid repeating validated bootstrap mining,1355 public blocks are imported from VM run43111959236. Only the pinned manifest and chain bytes are read; no old runtime, signed fixture, database, credential or key is executed/used. Manifest SHA256 `ace1f4d52cfac8c0cb68ad23c2ce603d2e0b0f1c4c92fe3f4591b0e24b1ac0b9`; stream SHA256 `3416b8b69aea7cd1f690810e068954ac3132197bd2a1ed074a7b0c89c6e25309`. Each fresh native node revalidates from genesis.

The existing manual executor retains D0 provenance/SBOM, exact binaries, UP loopback-only namespace, disabled wallets/DNS/public peers, standardness, native method counteraudit and bounded teardown. This mode creates no key, signs/broadcasts no transaction and forbids transaction RPC. Limits:16 new blocks,400 RPC,32 registered proofs,4096 bytes/proof,256 work attempts/proof,900 seconds. Original modes keep their caps.

The existing historical watcher checker requires agreeing tips before/after proofs, uncertainty during partition and agreement after reorg. Block agreement alone enables no transaction progression or settlement. All qualification phases remain BLOCKED pending complete criteria and independent review.

[source-index.json](research/2026-11-11/auxpow-boundaries/source-index.json) pins source hashes, error mappings and licensing. Complete synthetic proof bytes remain only in authorized native artifacts; bounded results will be committed after execution.
