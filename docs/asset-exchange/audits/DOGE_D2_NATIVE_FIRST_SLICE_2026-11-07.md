# Dogecoin D2 — native first-slice implementation (2026-11-07)

## Actual deliverables

This increment adds **executable source**, not an offline D2 qualification claim:

- `asset-exchange/qualification/dogecoin/d2/native-tx.mjs`: dependency-free Node 22 transaction constructor for the existing legacy P2SH HTLC template; independent in-memory compressed secp256k1 test keys for claim and refund; SHA256 commitment, legacy SIGHASH_ALL, DER ECDSA with normalized low-S, Bitcoin/Dogecoin legacy transaction serialization; test-only funding from a *mature* private-Regtest coinbase UTXO; two independent P2SH outputs plus change. Private keys are never serialized to an artifact.
- `asset-exchange/qualification/dogecoin/d2/native-regtest.mjs`: separate native Dogecoin 1.14.9 RPC executor, **only** when authorized and inside a separate Linux network namespace with loopback interface and no route table, with a wallet-disabled Regtest node. Mines synthetic blocks, checks exact source-derived genesis, funding UTXOs, negative invalid-key and invalid-preimage spends, accepted claim, rejected early refund, accepted refund after CLTV. Verifies mempool inclusion and confirmed input consumption. Records public txids, heights, environment, signed fixture hashes and bounded diagnostic policy lines in a JSON report.
- `asset-exchange/qualification/dogecoin/d2/run-native-isolated.sh`: **manual-only** launch path, D0 source archive hash pin and Sigstore provenance/SPDX verification before native node execution, extraction of only the expected `dogecoind` executable, sudo network namespace with loopback enabled, bounded CPU/file use, scoped authorization. Does not start from a PR/push trigger.
- `native-tx.test.mjs`, `native-regtest.test.mjs`: unit and adversarial tests, **not** live chain evidence. Added to `asset-exchange/package.json` zero-dependency suite.

## Repository review and supported commands

Pinned Dogecoin source: `dogecoin/dogecoin@v1.14.9`.
- The RPC to inspect is `signrawtransaction`, **not** Bitcoin Core's `signrawtransactionwithkey`, which is absent from Dogecoin 1.14.9. This runner signs legacy raw transactions in a separate in-memory test signer rather than using a node wallet or this RPC.
- Regtest `BIP65Height=1351`; SegWit/P2WSH is **not** assumed. Use the existing P2SH template and independently verify it under native script/policy flags.
- `generatetoaddress` exists in the 1.14.9 RPC source; no wallet RPCs are needed here.
- The native first slice tests distinct coinbase funding, claim, refund and negative cases, **not** the full 24-case frozen D2 scenario matrix.
- No test on a synthetic private chain establishes Mainnet policy, real funds safety or cross-chain atomicity.

## Tests and provenance in this increment

Local Node v22.16.0: `node --test native-tx.test.mjs native-regtest.test.mjs`: **19 PASS / 0 FAIL** in the working-copy test suite. The GitHub committed tx test file has a smaller selected regression inventory; rely on **head-specific CI** for its exact test count. `node --check` and `bash -n` locally PASS on the three executable files.

Exact Git blob identity of the committed implementations versus the tested local sources:
- `native-tx.mjs`: `ab62bc6c0367c661855e7aec35e310cb8f49dd39`.
- `native-regtest.mjs`: `b305745e96a35fb3790b1261006bd48b14099d91`.
- `run-native-isolated.sh`: `f14a8e677b1eeacf0e4a3ce2f18bd91666dbb2b7`.
- `native-regtest.test.mjs`: `6439cf4b643a5d8ec3312702775e1c54b629e2e6`.

The native launch was **NOT_TESTED** in the local workspace: neither `dogecoind` nor the original pinned D0 archive/attestation and privileged namespace environment are present. The runner fails closed outside the authorized isolation.

## Private native execution — manual, controlled

In a Linux host with `sudo unshare --net`, Node >=22, `gh`, `ip`, and the unchanged authenticated D0 archive/attestations already in a private directory:

```sh
# D0_DIR: directory containing the exact pinned D0 dogecoin-1.14.9 tar,
# provenance.sigstore.json and sbom-attestation.sigstore.json.
# OUTPUT_DIR: a **nonexistent**, disposable directory for this one experiment.
bash asset-exchange/qualification/dogecoin/d2/run-native-isolated.sh \
  "$D0_DIR" "$OUTPUT_DIR" \
  AUTHORIZE_DOGE_D2_SYNTHETIC_SIGNING_AND_PRIVATE_REGTEST_ONLY
```

Never supply real keys, Mainnet RPC endpoints or a path containing user data. Do not run this on an ordinary push/PR CI runner. Check the complete exact-scope allowlist, binary and runtime environment before manually executing.

## Acceptance gates — what remains BLOCKED

1. Head-specific unit CI validation plus actual private native execution of the first slice; no actual txids or node acceptance evidence exist in this commit yet.
2. Frozen 24-case native matrix with independent expected failure layer, strict `IsStandardTx`/`AreInputsStandard` policy probes, exact active consensus script flags, fee/dust and P2P relay distinctions. RPC acceptance by itself cannot prove policy completeness.
3. UTXO/reorg/conflict and crash/refund recovery on independent hosts, protected pre-lock recovery bundle, signed fixture identity and D0 runtime proof acceptance.
4. All DOGE D3–D9 gates and BTC–DOGE cross-chain atomicity.
5. Rust `glib`/`rand` advisories remain open (issue #342); scanner discrepancy for `borsh` needs independent verification. No Rust changes here.

**D2 qualificationStatus=BLOCKED, all DOGE/BTC/ZEC/XMR/PEARL financial routes BLOCKED, automatic settlement disabled. No Mainnet, real funds, shared runtime, merge or deployment.**

Reference: https://github.com/dogecoin/dogecoin/blob/v1.14.9/src/rpc/rawtransaction.cpp
