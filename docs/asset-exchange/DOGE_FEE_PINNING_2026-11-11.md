# DOGE native fee and pinning matrix — 11 November 2026

Base: PR354 at `a5eb4d065ec8443c6cf13fdc8c18cec97a64e6ed`, tree `c807e535df469f2422886b3361473a5754fc8730`. The prior174 software checks, D3 four-case/2357-assertion run, eight AuxPoW controls and keyless0.99DOGE run are retained. This increment uses another mode of the existing D6 runner, not another executor. The prior native suite is not selected again.

## Pinned policy findings

Dogecoin1.14.9 enables replacement by default, but checks the original conflicting transaction: an input must have sequence below0xfffffffe. Our immutable recovery profile deliberately uses0xfffffffe, so paying more cannot authorize replacement of its still-pending transaction. Explicit opt-in controls use a different synthetic UTXO; node A admits a sufficient replacement while node B disables replacement. Neither outcome changes consensus validity or the Exchange profile.

The pinned native policy also requires increasing direct-conflict feerate, coverage of all evicted descendant fees, incremental relay bandwidth fees, no newly added unconfirmed input outside the original parents, and bounded replacement/ancestor graphs. The prepared native experiment covers the economical descendant pin; the remaining replacement-count and newly-added-input boundaries are source-reviewed, not claimed as native cases. Legacy funding TXID mutation remains a reason to require the exact funding bytes and a confirmed active-chain funding anchor.

Source hashes and established-project references are in [source-index.json](research/2026-11-11/fee-pinning/source-index.json). No modern Bitcoin full-RBF/package policy is presumed.

## Required fifteen scenarios

Native status at preparation: **NOT_TESTED**. Every case must produce actual native observations before it can be recorded as successful. A complete run must retain each case ID1–15 exactly once.

| ID | Scenario | Expected-result layer |
| --- | --- | --- |
| 1 | pending-refund | mempool-policy/exchange-protocol |
| 2 | higher-fee-replacement | mempool-policy |
| 3 | lower-fee-replacement | mempool-policy |
| 4 | claim-conflict | mempool-policy/consensus |
| 5 | rising-minimum-while-waiting | mempool-policy |
| 6 | falling-minimum-while-waiting | mempool-policy/exchange-protocol |
| 7 | transaction-lost-from-mempool | mempool-policy/exchange-protocol |
| 8 | node-restart | mempool-policy/exchange-protocol |
| 9 | different-node-policies | mempool-policy |
| 10 | unconfirmed-parent-and-descendant | mempool-policy/exchange-protocol |
| 11 | deliberate-economic-pinning | mempool-policy |
| 12 | original-signing-keys-removed | exchange-protocol |
| 13 | presigned-coverage-exhausted | exchange-protocol |
| 14 | reorganisation-during-conflict | consensus/exchange-protocol |
| 15 | unauthorized-replacement-refused | exchange-protocol/mempool-policy |

## Exact effects and bounds

Two D0-qualified native nodes, UP loopback-only namespace, no wallets/DNS/public peers;1370 generated blocks maximum,800 total RPC maximum including standalone calls,96 registered signed fixtures maximum. At most64 pressure transactions each have1601 standard outputs and fewer than60000 bytes. This explicit larger test-codec bound does not change the default eight-output recovery bound. Both nodes enforce standardness.

All recovery bundles are semantically checked, fsynced and read back before funding; all four ephemeral keys are removed before funding broadcast. A normal node restart checks native mempool reload and service-cookie rotation. A separate incident withholds only the disposable node's own mempool dump by reversible rename, preserving its chain and UTXOs. This is declared fault injection, not a physical outage claim.

Real bounded mempool pressure must evict the low-fee refund and increase the actual native minimum. A one-step capped bundle must refuse without broadcasting; the authorized wider already-signed ladder must recover. For a falling minimum while a higher-fee refund stays pending, one block from the partitioned peer enables native rolling-fee decay; the private Regtest clock advances six hours, below24-hour mempool expiry. No six-hour real wall-time wait is claimed.

The recovery adapter now refreshes only its explicitly selected private blockchain RPC credential after restart and enforces the remaining parent RPC budget before each subprocess. Its public package and bundle remain pinned. Expected refusals are limited to three exact protocol errors, never arbitrary ignored failures.

All experiment success remains separate from D2–D9 and financial activation. Real-machine/VM independence, broader AuxPoW expansion, hardware signers, complete phase review and external audit are separate acceptance work. No funds, production activation or merge is authorized.
