# GPUbnb Pearl (PRL) — evidence log, 2026-11-22

Scope: **PRL native L1 research**, no production activation or financial route.
Branch: `experiment/pearl-prl-offline-preflight-20261122`.
Base: `experiment/doge-d8-ledger-emulator-free-20261122`.
DO NOT change the DOGE branch or local DOGE worktree.

## Discovery and provenance

1. GPUbnb `apps/host-desktop/src/main.ts` has
   `{ symbol: 'PRL', name: 'Pearl' }` in `MINING_CATALOG`,
   with no executable profile or validated hardware indicator.
2. `docs/asset-exchange/ASSET_ACTIVATION_MATRIX_V1.md`
   lists `pearl-mainnet-native` as
   `MARKETPLACE_ONLY / RESTRICTED / identity not ready`.
3. User corrected an earlier ticker typo: **PRL**, not MTN.
4. Official project: https://pearlresearch.ai and
   https://github.com/pearl-research-labs/pearl .
   Source snapshot examined by GitHub read:
   `29c2b03009143c98f4519271d716bd5535762a18`.
5. Static Go reference source `node/chaincfg/params.go`,
   `node/wire/protocol.go` and `node/btcutil/address_test.go`
   identifies the `prl/tprl/rprl` Bech32 HRPs, distinct network
   magics and candidate P2TR v1. **Regtest and simnet share `rprl`**.
   P2MR uses v2 in `node/btcutil/address.go`; it is intentionally
   rejected by the candidate v1-only guard.

**P0/P1 NOT QUALIFIED**: no authenticated binary release,
no actual genesis/node identity attestation, no executable Pearl
Core daemon; no evidence of real mining/recovery/transaction semantics.

## Initial code-and-test evidence

Files created only under
`asset-exchange/qualification/pearl/` plus Pearl-only documents:

- Bech32m/v1 `rprl` classification of a public synthetic
  32-byte witness program; no script interpreter, no keys.
- Synthetic, non-posted PRL/DOGE public-offer fixture;
  strictly bound PRL symbol/chain and false financial permissions.
- Two suites with **47 distinct unittest methods**.

Local developer sandbox run (not the user's WSL2):

```text
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s . -p 'test_*.py' -v
Ran 47 tests in 0.011s
OK
```

This local run was **without network namespace isolation**, but the
Python modules contain no networking or file I/O code. The intended
WSL2 qualification command uses `unshare --user --map-root-user --net`.
No user WSL2 PRL tests have yet been reported.

No live offers, public exchange endpoint changes, transactions,
wallets, private keys, signatures (even synthetic), node, miner,
RPC, broadcast, real funds, Docker or production deployment.
**P2 outcome: OFFLINE_SHAPE_PASS only. P0/P1 and P3–P9 blocked
or deferred.**

## Required follow-up

- Operator: test the Pearl branch in a **distinct detached worktree**
  with `PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net`;
  log exact commit, test count, errors and git cleanliness.
- Independent upstream provenance; script/policy audit; identity binding
  independent of HRP; later separate reviewed marketplace-only listing
  implementation if allowed.
- Keep `MARKETPLACE_ONLY`, `RESTRICTED`,
  `automaticSettlementSupported=false`, and PR in **draft**.

## Local offline network-namespace rerun of the exact published Python files

The five source/fixture blob SHAs were checked against the locally tested files:

```text
address_guard.py                 ffa0c4929035c236325a1f6d3624e752730787a7
offline_preflight.py             c52eebc97d88f55e43d2b7cec6e5fdbd238e578f
test_address_guard.py            ced428cdb58c6b008ec71636053ba0530c122f5b
test_offline_preflight.py        717cbcfe1abfcabace141bc8ba6685710c6bf5a2
fixtures/public_prl_offer_v1.json abd1c8e1d93ebb4b28c35eb31b483bbecee5b999
```

With the exact same files, a second local run used a real user/network
namespace. It returned:

```text
PYTHONDONTWRITEBYTECODE=1 unshare --user --map-root-user --net python3 -m unittest discover -s . -p 'test_*.py' -v
Ran 47 tests in 0.009s
OK
```

**Qualification evidence: 47/47 tests PASS in the assistant sandbox,
including a network-namespace run.** This is **NOT** yet a run on the
operator's WSL2 computer. No PRL full-node, RPC, miner, hardware,
wallet, signing, network broadcast or real funds was used.

**P0–P9 remain not qualified for real financial settlement.**
