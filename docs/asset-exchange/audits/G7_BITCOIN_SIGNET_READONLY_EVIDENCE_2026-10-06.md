# gpu.k.p2p — G7 Bitcoin Signet Read-Only Qualification Evidence — 2026-10-06

Status: PUBLIC TEST NETWORK READ-ONLY EVIDENCE / NO WALLET / NO TRANSACTION / NO MAINNET AUTHORIZATION

## Scope

This evidence records the first gpu.k.p2p Asset Exchange qualification against Bitcoin Core's public default signet.

It is intentionally read-only.

It does NOT:
- create or load a wallet;
- request faucet funds;
- sign a transaction;
- submit a transaction;
- exercise HTLC settlement on signet;
- authorize Mainnet.

## Toolchain

Pinned Bitcoin Core:
- version: `31.1`;
- official Linux archive SHA-256: `b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e`;
- archive verified before extraction.

Workflow:
- name: Asset Exchange Bitcoin Signet Readonly;
- run id: `37529763126`;
- source commit: `4ec50256b1d33b47e49460786cb46cf163038ae6`;
- conclusion: SUCCESS.

G5 on the same source:
- workflow run id: `37529763110`;
- conclusion: SUCCESS.

## Network constraints

The qualification node used:
- `signet=1`;
- `disablewallet=1`;
- `listen=0`;
- `discover=0`;
- `dnsseed=1`;
- IPv4 outbound networking only;
- `blocksonly=1`;
- `persistmempool=0`;
- RPC bound to loopback.

After qualification, `setnetworkactive false` is called and peers must drain to zero.

## Chain identity

Observed:
- chain: `signet`;
- genesis:
  `00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6`;
- best-header height at qualification: `322000`;
- locally validated block height at qualification: `224`;
- connected peers before shutdown: `3`.

The gate also validated a block header known from the pinned Bitcoin Core 31.1 signet profile:
- height: `160000`;
- hash:
  `0000003ca3c99aff040f2563c2ad8f8ec88bd0fd6b8f0895cfaf1ef90353a62c`.

Bitcoin Core's header index returned that exact hash at that exact height after header sync passed height 160000.

## Header-index correction discovered by the gate

The first implementation attempted:

`getblockhash 160000`

before the node had fully downloaded 160000 blocks.

Bitcoin Core correctly rejected that request because `getblockhash(height)` addresses the active fully validated block chain, not merely the synchronized header index.

The gate was corrected to:
1. require best-header height >= 160000;
2. query the exact known hash through `getblockheader(hash)`;
3. require returned `height == 160000`.

The first corrected run then exposed a stale output variable in the harness. That was fixed without weakening the security condition.

No failed condition was bypassed.

## Non-custodial evidence

Observed:
- `wallet_enabled=no`;
- `transaction_broadcast=no`.

No wallet directory containing wallet data was permitted by the gate.

This proves the first public-network qualification did not introduce wallet custody or transaction authority into CI.

## What this evidence proves

Within the pinned Bitcoin Core 31.1 environment:
- the official binary hash verifies;
- Core identifies the public network as default signet;
- the expected signet genesis is active;
- public outbound peer discovery/connectivity works;
- headers synchronize beyond a pinned historical signet height;
- a known v31.1 signet header is present at the expected height;
- at least one non-genesis block is fully validated;
- no wallet is enabled;
- no transaction is broadcast;
- networking can be explicitly disabled after qualification.

## What this evidence does NOT prove

Still required before transactional signet qualification:
- controlled source of valueless signet coins;
- non-custodial signer path for the public-test transaction;
- signet funding output creation;
- signet HTLC redeem;
- signet CLTV refund;
- signet recovery-before-lock;
- signet fee-bump/RBF behavior for the actual settlement transaction;
- signet watcher/reorg behavior for a funded trade;
- signet recovery drill with the released recovery artifact.

Still required before Mainnet:
- production risk/timeout profile;
- repository-level controlled release protections verified;
- full product release SBOM/provenance;
- independent external security audit/red-team;
- explicit owner authorization for a Mainnet canary.

No Mainnet authorization.
No real-funds authorization.
