# Independent DOGE recovery VM experiment

Base: PR356 at `26e27eb06bd22b7aa029c5b60e307c54138993df`, itself based on PR354 at `a5eb4d065ec8443c6cf13fdc8c18cec97a64e6ed`. The fifteen-case native fee/pinning evidence is preserved and is not selected again. This is another explicit mode of the existing executor, not a concurrent replacement laboratory.

Native status: **PASS** in manual run [43111959236](https://github.com/khemisset18/gpubnb/actions/runs/43111959236), execution `6307538265aef8273447891f445a28531043d1b5`, frozen source `19f20a368c15b5cd762c9cb76fecc3549fc3dfe1`. Fourteen incidents passed on the independent VM; a separate fresh-VM replacement check passed on the third VM. This count does not claim a literal in-place reboot. Software checks in the producer job:31 laboratory,22 recovery,12 signer/fee and24 watcher PASS. Full D2–D9 and financial activation remain BLOCKED.

## Separation and handoff

The manual-only workflow has three sequential `ubuntu-24.04` jobs. GitHub documents a new hosted VM for each standard multi-CPU runner job; these are not single-CPU `ubuntu-slim` containers. Distinct boot identity hashes must additionally be observed. Physical-machine independence remains NOT_TESTED: these jobs do not establish separate physical hosts.

The first job uses the existing signer/codec and two D0-qualified nodes to prepare synthetic fixtures. Four bundles are semantically verified, fsynced and read back before funding; all four original signing keys are removed before funding broadcast. Only public block bytes are exported through the native `getblock hash false` RPC. No node database, wallet, cookie, key directory, server source or Exchange database is transferred.

The second and third jobs have no repository checkout and no cache restore. They receive a closed file allowlist: the existing qualification/recovery runtime, public chain bytes, synthetic signed fixtures, four public bundles and hash receipts. Before executing any handoff code, an inline workflow verifier checks the manifest against the digest retained in the completed producer job's outputs, safe paths, single-link regular files, every file hash and a32MiB total bound. The trusted runtime repeats strict allowlist/bundle checks. A rewritten manifest cannot authorize its own receipt.

Each recovery VM verifies the original D0 archive and both attestations again, starts fresh genesis-only node directories, then imports the public block stream using Dogecoin1.14.9 `-loadblock`. The stream has exact Regtest message framing, bounded lengths and the ordered child-header identities/previous links. Native import separately checks consensus and AuxPoW. The consumer never receives or generates a signing key. Native execution uses the existing UP loopback-only namespace and a cleared environment; only explicitly authorized local blockchain RPC is available.

The original VM's blockchain services can be gone: the consumer reconstructs its own authorized private blockchain services from public data. This is a test-network reconstruction, not permission to substitute Mainnet or to bypass active-chain verification.

## Incidents and exact limits

The second VM runs14 distinct incidents: absent backend, actual disconnected RPC client, corrupt bundle, attacker-modified bundle against a retained receipt, wrong network, wrong destination, wrong amount, already-confirmed refund, claim-blocked refund, divergent mempools, rollback of a confirmed refund, exhausted pre-signed fee coverage, duplicate attempts and missing original signer. Invalid data must refuse without broadcasting. The offline diagnostic wrong-network/destination/amount variants use explicitly recomputed test digests to exercise semantic validation; the separate attacker test keeps the original independent receipt.

The connection-loss incident creates an additional loopback-only client namespace with no blockchain service. It is observation-only and accepts only the exact `RPC getblockchaininfo failed` refusal. Its attempted RPC consumes the shared budget but is not counted as a request reaching a native server. Every other native request must still exactly match the daemon method counters.

The conflict test confirms a refund on the longer four-block branch, temporarily invalidates that branch on the partitioned consumer node, requires the standalone `REORGED` transition, then reconsiders the same branch. Real bounded pressure on the consumer's own5MB mempool must evict the cheap main refund. The capped ladder must refuse; the wider existing ladder must recover0.99DOGE without another signature. Both nodes must confirm the exact destination and amount.

The third fresh VM demonstrates recovery-machine replacement with the entire prior process/workspace absent. It replays the updated public chain and must return `ALREADY_CONFIRMED` with zero broadcasts. **This does not claim an in-place OS/VM reboot or a physical power-loss test. Those remain NOT_TESTED.** The executable handoff protocol can also be run on a separately provisioned Linux machine using the same verified D0 archive, retained manifest receipt and existing `run-multinode.sh` consumer mode.

Producer bounds:1355 public block exports,1800 RPC maximum,1370 generated blocks maximum. Consumer bounds:800 total RPC including standalone attempts,16 newly generated blocks maximum,96 registered fixtures maximum,80 pressure transactions maximum,60000 bytes per fixture,16MiB public chain stream,900 seconds wall time. Original multinode and fee-pinning mode bounds remain unchanged. All nodes keep standardness, disabled wallets/DNS/public peers and fixed Regtest identity.

## Sources

- Dogecoin Core1.14.9 at `e0a1c157791544e818c901bd9341896965afbf9d`: `src/init.cpp` external block import, `src/validation.cpp` `LoadExternalBlockFile`, `src/rpc/blockchain.cpp` raw block serialization, `src/primitives/pureheader.cpp` child header identity and Scrypt work distinction, and `src/chainparams.cpp` exact Regtest magic. Existing MIT attribution is retained; no modern Bitcoin replacement or package-relay assumption is introduced.
- [GitHub-hosted runner documentation](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners), checked11November2026: fresh VM per standard multi-CPU job, single-CPU container exception, exact image provenance in job setup logs. This is evidence about hosted VM provisioning, not proof of different physical hosts.

Signed synthetic handoff/evidence archives belong in the authorized workflow artifacts, never the repository. Only bounded results, hashes and refusal reasons will be committed after native verification.

## Verified native results

All three native jobs passed on standard `ubuntu-24.04` image `20261101.360.1`, runner `2.338.2`. The [bounded result index](research/2026-11-11/vm-recovery/native-result.json) preserves the three distinct boot hashes, exact source/parcel/evidence hashes and all refusal reasons.

| Stage | Newly generated blocks | Total RPC | Standalone invocations | Actual result |
| --- | ---: | ---: | ---: | --- |
| Producer VM |1355 |1396/1800 |0 | Keys removed before funding;1355 public blocks exported |
| Independent recovery VM |6 |426/800 |12 |14 incidents PASS;0.99DOGE refund confirmed on both native nodes |
| Replacement recovery VM |0 |43/800 |1 |1360 public blocks revalidated; `ALREADY_CONFIRMED`, zero broadcasts |

The confirmed refund TXID is `90dd851fb924fa20317e23f0cd84d97aa7f1e1ea8c126d544f5a3cf1033d6733`. The four-block rollback produced `REORGED` and reconsideration restored `CONFIRMED`. Actual77-transaction pressure raised the independent node's floor to0.01841703DOGE/kB; exhausted coverage refused without broadcasting, and the existing0.01DOGE signature retained0.99DOGE with zero new signatures. An actually disconnected standalone client returned only the exact connection refusal, consumed one attempted RPC and reached neither native server.

Prepared parcel manifest SHA256: `ace1f4d52cfac8c0cb68ad23c2ce603d2e0b0f1c4c92fe3f4591b0e24b1ac0b9`; confirmed parcel manifest: `0d711f6c5b3828e619f8237dd6097c4ec5c204e3f0889466ded02e93e1675941`. All five artifact ZIP hashes, three internal checksum lists, six native method counters, both parcel receipts/allowlists/source bytes, four bundle signatures/terms, ordered public header identities and original native raw-block responses were rechecked after download. Both recovery-node transaction bytes/confirmation anchors and the replacement VM's native tip/standalone confirmed receipt were verified. Full signed archives remain outside git.

A packaging-only follow-up includes the full existing MIT notice `d2/DOGECOIN_COPYING` in the distributed allowlist. Its updated allowlist and all unchanged native payload bytes were checked offline against the actual prepared parcel. The native proof above remains attributed to its exact execution/source commits; no new mining/signing/broadcast is claimed for this license-text addition. Physical-host independence and a literal in-place VM reboot remain NOT_TESTED.
