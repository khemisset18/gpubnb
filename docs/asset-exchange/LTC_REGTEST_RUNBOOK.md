# Litecoin native Regtest — operator runbook (PREPARATION ONLY)

**Not authorized to execute by this document.** L0 provenance and trust chain
must pass before any node is launched. Obtain separate permission for each native
mining/signature/broadcast test batch. Never connect to Mainnet, testnet or public
RPC. Test coins only; never real financial value. No automation on ordinary push/PR.

## Controlled environment checklist
1. Use a dedicated disposable VM or host namespace with isolated storage.
   Disconnect from GPUbnb Core, DOGE, cloud metadata, all production secrets,
   and public Litecoin peers; firewall default-deny egress.
2. Pin the *independently authenticated* Litecoin Core binary, source SHA,
   build metadata, operator and OS/container digest; no generic `latest` tag.
3. Use dedicated LTC-only private data directory, loopback-only RPC bind,
   short-lived dedicated credentials stored outside Git, and explicit
   `regtest` configuration. No public RPC, UPnP, external peer or inherited
   Litecoin/Bitcoin/DOGE config. Record CPU/RAM/disk/time/RPC rate limits.
4. Explicitly reject accidental `main`, `test`, signet, wrong
   genesis/magic, unexpected peer, external RPC URL or inherited settings.
   Obtain genesis and chain identity from independently reviewed upstream
   source; these are not frozen by V1.
5. For an authorized L1-only run, use native read-only RPC calls such as
   `getblockchaininfo` and `getblockhash 0` against the dedicated instance.
   Save redacted responses and both chain/network identity checks; inspect
   firewall counters and peer list. Do not mine, sign, fund, or broadcast in L1.
6. Exit non-zero on any mismatch, firewall egress, unbounded resource use,
   external peer, unexpected wallet or RPC. Shut down and archive redacted
   logs with SHA-256 hashes and VM identity. Wipe ephemeral credentials.

## Exit criteria
L1 remains NOT_TESTED until an independently proven Litecoin-native Regtest
instance has passed all isolation and negative-case checks on its exact SHA.
Additional L2 MWEB and L3 script tests require a separate approved test plan.
