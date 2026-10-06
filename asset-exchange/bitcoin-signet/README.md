# Bitcoin default signet read-only qualification

Status: G7 PREPARATION / READ-ONLY PUBLIC TEST NETWORK / NO WALLET / NO BROADCAST / NO MAINNET.

## Purpose

This gate verifies that the pinned Bitcoin Core 31.1 toolchain can connect to and identify the official default signet before any Asset Exchange transaction is attempted on a public test network.

It intentionally performs no wallet or settlement action.

## Security constraints

The node runs with:
- `signet=1`;
- `disablewallet=1`;
- `listen=0`;
- `discover=0`;
- IPv4 outbound networking only;
- block-only relay mode;
- RPC bound to loopback;
- no transaction creation;
- no transaction signing;
- no faucet;
- no broadcast.

After qualification, network activity is explicitly disabled and peer count must return to zero.

## Pinned Bitcoin Core 31.1 signet identity

The gate verifies values from the Bitcoin Core v31.1 source profile:
- genesis: `00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6`;
- known signet block hash indexed at height 160000: `0000003ca3c99aff040f2563c2ad8f8ec88bd0fd6b8f0895cfaf1ef90353a62c`;
- default signet target spacing: 600 seconds.

The 600-second target is not treated as a timing guarantee.

## What passing proves

Passing shows:
- Bitcoin Core is running the signet chain;
- outbound signet peer discovery/connectivity works;
- header sync reaches at least height 160000 and Bitcoin Core's block index contains the exact v31.1-known signet header at that height;
- at least one non-genesis signet block is validated;
- no wallet is created;
- no transaction is broadcast.

## What passing does not prove

It does not prove:
- funding/redeem/refund on signet;
- mempool acceptance of gpu.k.p2p settlement transactions on signet;
- faucet availability;
- hardware-wallet compatibility;
- Mainnet readiness.

A later G7 transaction qualification must use valueless test coins and must remain non-custodial.

## Header-vs-block validation note

The gate deliberately does not call `getblockhash 160000` before full block sync.

Bitcoin Core's `getblockhash(height)` reads the active fully validated chain and therefore rejects heights above the current block tip. In contrast, `getblockheader(hash)` looks up the header in Core's block index. The read-only qualification waits until the best-header height is at least 160000, then queries the exact known v31.1 signet block hash and requires Core to report `height=160000`.

This validates the public signet header-chain identity without requiring a 160000-block initial block download merely for the network-identity gate.
