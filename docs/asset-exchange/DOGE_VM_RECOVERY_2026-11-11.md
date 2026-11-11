# Independent DOGE recovery VM experiment

Base: PR356 at `26e27eb06bd22b7aa029c5b60e307c54138993df`, itself based on PR354 at `a5eb4d065ec8443c6cf13fdc8c18cec97a64e6ed`. The fifteen-case native fee/pinning evidence is preserved and is not selected again. This is another explicit mode of the existing executor, not a concurrent replacement laboratory.

Native status before execution: **NOT_TESTED**. Software checks executed:31 laboratory,22 recovery,12 signer/fee and24 watcher PASS. Full D2–D9 and financial activation remain BLOCKED.

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
