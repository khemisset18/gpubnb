# New native DOGE AuxPoW boundaries

Base: PR357 at `dfc072becc46252c38b81dde25fcc302f40a52c0`, preserving PR354's eight native controls, PR356's fifteen fee cases and PR357's independent VM recovery. The earlier eight AuxPoW controls are not selected again.

Native status: **12 new properties PASS,0 FAIL,0 SKIP** in [manual run43311713839](https://github.com/khemisset18/gpubnb/actions/runs/43311713839). The additional boundary-block reorganisation also passed. Execution `c7adde84149250c3a972e570b5df4911b20778ee`, frozen source `eadb9c1e3265cf3858a0bebdc0917964b8f89ede`. Full D2–D9 and financial activation remain BLOCKED.

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

[source-index.json](research/2026-11-11/auxpow-boundaries/source-index.json) pins source hashes, error mappings and licensing. Complete synthetic proof bytes remain only in authorized native artifacts; the [bounded result](research/2026-11-11/auxpow-boundaries/native-result.json) contains hashes and observations.

## Verified execution

The two native nodes made133/400 total RPC calls, imported1355 previously verified public blocks and generated only8 new blocks. No key was created; no transaction was signed or broadcast. Six consensus negatives returned native false on both nodes with their distinct new reasons. Two malformed encodings returned native RPC code-1 on both nodes, with the exact end-of-data/noncanonical-read markers. All16 rejected submissions preserved their tips. Four valid boundaries were decoded on both nodes. The longer branch orphaned three boundary blocks and converged at `2701d9d59dee2cdfebb8fe4cd6faad0ecf49baa6b4d78b349d838d78f7a7ddc2`; all six orphan-header observations reported confirmations-1. Historical watcher review was UNCERTAIN during partition and CONSISTENT after convergence; financial progression remained false throughout.

Artifact13985234147 SHA256 `5f6910e54b6160bf625393893ee96fd51b8441208f10eacfdcbf8fa64c2e05cb` was downloaded and independently checked. The review parsed all20 transmitted inputs:16 complete proofs had adequate independently recomputed Scrypt work and coherent parent Merkle roots; four malformed serializations were independently rejected by the strict decoder. Both native decoded structures matched the complete accepted consensus fields. Native JSON's `tx.blockhash` is computed from the parent header; it does not expose the ignored MerkleTx wire hash, which is identified separately. Both full native method counters and all internal file checksums reconcile.

The native job also passed37 laboratory,12 signer/fee,22 recovery and24 watcher software checks. D3 and both recovery-VM jobs deliberately skipped. Existing proof runs remain unchanged.

The portable [offline verifier](research/2026-11-11/auxpow-boundaries/verify-native-artifact.py) checks this exact artifact's independent ZIP digest before extracting bounded safe paths, then verifies the proof fields, actual RPC results, log reasons, orphan headers and counters. It never starts Dogecoin or performs RPC:

```sh
python3 verify-native-artifact.py dogecoin-private-multinode-c7adde84149250c3a972e570b5df4911b20778ee.zip
```
