# Bitcoin regtest harness

Status: G5/G6 preparation only. No Mainnet. No real funds.

## Purpose

This harness validates the environment and failure semantics before any Bitcoin settlement implementation is allowed.

It currently proves only:
- official Bitcoin Core binary is checksum-pinned by CI;
- chain is `regtest`;
- P2P listening/discovery are disabled;
- RPC is loopback-only;
- a disposable descriptor wallet can mine and spend valueless regtest coins;
- a transaction moves from mempool -> confirmed -> reorged -> confirmed again.

It intentionally does **not** implement the final gpu.k.p2p HTLC/lock/redeem/refund script.

## Toolchain

Bitcoin Core 31.1 is pinned in `BITCOIN_CORE_TOOLCHAIN.lock`.

The SHA-256 is copied from the Bitcoin Core Guix release attestation:
`bitcoin-core/guix.sigs/31.1/fanquake/all.SHA256SUMS`.

CI downloads the release from `bitcoincore.org` and fails before extraction if the archive hash differs.

## Isolation

The test node runs with:
- regtest;
- `listen=0`;
- `dnsseed=0`;
- `discover=0`;
- loopback RPC only;
- temporary datadir destroyed at exit.

No public Bitcoin network should be contacted.

## Next security gates

Before implementing actual lock/redeem/refund templates:
1. audited byte-level script template;
2. exact sighash policy;
3. refund fee-bump strategy;
4. malleability analysis;
5. PSBT signer policy;
6. timeout derivation;
7. crash-before/after-broadcast tests;
8. independent review.
