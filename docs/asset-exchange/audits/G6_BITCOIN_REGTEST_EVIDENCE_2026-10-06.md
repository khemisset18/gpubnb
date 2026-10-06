# gpu.k.p2p — G6 Bitcoin Regtest Security Evidence — 2026-10-06

Status: INTERNAL SECURITY EVIDENCE / REGTEST ONLY / NO REAL FUNDS / NO MAINNET AUTHORIZATION

## Scope

This evidence package records the first end-to-end Bitcoin P2WSH HTLC security tests for the Asset Exchange.

Pinned toolchain:
- Bitcoin Core 31.1;
- official archive SHA-256: `b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e`;
- release checksum sourced from Bitcoin Core Guix attestations;
- public Bitcoin networking disabled in the harness.

Evidence workflow:
- workflow: Asset Exchange Bitcoin Regtest;
- workflow run id: `37415551621`;
- source commit: `8408db4743b608afe8174ef79b6297d83df590ea`;
- conclusion: SUCCESS.

G5 foundation on the same commit:
- workflow run id: `37415551717`;
- conclusion: SUCCESS.

## 1. Exact script / Miniscript equivalence

The reviewed byte-level P2WSH script is generated independently by the Asset Exchange builder.

Bitcoin Core 31.1 then:
1. decodes the witness script;
2. recognizes the required opcodes;
3. compiles the canonical Miniscript policy;
4. derives the P2WSH address;
5. verifies that descriptor and byte-level builder resolve to the same P2WSH output.

Observed evidence:
- `Bitcoin Core decoded reviewed HTLC script and matched canonical Miniscript descriptor successfully.`

This blocks an implementation from silently drifting away from the reviewed policy.

## 2. Redeem path

The redeem test uses:
- a 32-byte preimage;
- SHA-256 hashlock;
- valid secp256k1 redeem key;
- SIGHASH_ALL;
- Miniscript/descriptor finalization by Bitcoin Core.

Adversarial coverage:
- malformed/fake secp256k1 public points rejected by runtime builder;
- wrong preimage cannot produce an accepted spend;
- correct preimage without redeem private key cannot finalize before refund timeout;
- correct preimage + correct key finalizes;
- final witness contains the expected preimage and reviewed witness script;
- transaction passes `testmempoolaccept`;
- redeem confirms;
- redeem reorgs back to mempool;
- confirmation is restored after reconsidering the block.

Observed evidence:
- `HTLC redeem path regtest passed.`

## 3. Refund path

The refund path proves:
- CLTV refund is rejected before its block height;
- refund becomes relayable only after the lock height;
- refund is finalized by Bitcoin Core's descriptor/Miniscript engine;
- refund confirms;
- refund returns to mempool after a forced block invalidation;
- confirmation is restored after reconsideration.

Observed evidence:
- `HTLC refund path regtest passed.`

## 4. Refund fee replacement

The harness broadcasts a low-fee valid refund, then constructs and signs a replacement spending the same HTLC principal to the same refund destination with a higher fee.

Observed mempool data:
- original fee: `0.000002 BTC`;
- original vsize: `131 vB`;
- replacement fee: `0.00001 BTC`;
- replacement vsize: `131 vB`.

Bitcoin Core 31.1:
- accepted the replacement via current mempool replacement rules;
- removed the original refund from the mempool;
- accepted the replacement txid;
- confirmed the replacement;
- returned it to mempool on reorg;
- restored confirmation after reconsideration.

This is evidence that the chosen refund sequence and construction support an RBF fee-bump path in the pinned singleton-regtest scenario.

It is NOT proof against every production pinning/package/cluster scenario.

## 5. Crash-safe transaction reconciliation

A signed redeem transaction is persisted as raw transaction hex with restrictive local file permissions.

The recovery reconciler is forbidden from constructing a replacement economic action. It can only inspect and rebroadcast the exact same signed transaction.

The harness simulates:
1. crash before broadcast;
2. lost RPC response / crash after broadcast before txid persistence;
3. crash after confirmation before application-state commit.

Observed states:
- `BROADCAST`;
- `MEMPOOL`;
- `CONFIRMED`.

Observed evidence:
- `crash_recovery_states=BROADCAST,MEMPOOL,CONFIRMED`.

The same test still passes the subsequent forced reorg.

## 6. Recovery-before-lock invariant

The strongest recovery test changes the order of operations:

1. construct funding PSBT;
2. require native SegWit inputs;
3. sign/finalize funding transaction WITHOUT broadcasting;
4. compute stable signed funding txid and exact HTLC vout;
5. construct refund against that final outpoint;
6. inject exact witness UTXO into refund PSBT;
7. sign/finalize refund while funding is still offline;
8. create user-side recovery encryption key;
9. create AES-256-GCM recovery bundle containing:
   - exact signed funding transaction;
   - exact funding txid;
   - exact signed refund transaction;
   - recovery recipe metadata;
10. decrypt and validate bundle before any funding broadcast;
11. delete plaintext preparation copies;
12. verify funding is still absent from mempool;
13. only then broadcast the already-signed funding transaction.

This directly tests the invariant:

`PREPARE -> BUILD RECOVERY -> VERIFY -> EXPORT -> ONLY THEN LOCK`

## 7. Standalone refund with wallet unloaded

After funding confirmation:
- the test wallet is unloaded;
- no wallet RPC is available for refund signing;
- the encrypted recovery bundle is decrypted using the user-side recovery key;
- the pre-signed refund is extracted;
- Bitcoin Core validates it with `testmempoolaccept`;
- it is broadcast and confirmed using only node access.

Observed evidence:
- `Recovery-before-lock standalone refund passed.`
- `wallet_loaded_during_refund=no`

Prepared funding txid:
- `31ab494528c788cbef6974633631c8a2d35d11a18be8f96e5f9c09ca7ad705c3`

Standalone refund txid:
- `f62df52e7f2fd23731dc0f6ed7e0c4c49d04851163cdafc1b1e5869b986cbe86`

These txids are valueless regtest evidence only.


## 8. Multi-node conflicting tips and losing-fork transaction recovery

A separate two-node isolated regtest scenario now exercises an actual network partition.

Topology:
- node A and node B bind P2P only on loopback;
- both begin on the same 101-block baseline;
- the nodes disconnect completely;
- node A extends a shorter fork;
- node B extends a longer fork;
- watcher tip evidence is evaluated while both honest nodes disagree;
- the nodes reconnect and converge to the heavier chain.

Security evidence:
- during partition, distinct honest tips produce `UNCERTAIN`;
- duplicate source IDs cannot satisfy the tip quorum;
- the shorter fork does not win after reconnect;
- both watchers return `CONSISTENT` only after identical tip hash and height.

A transaction was also confirmed on node A's losing fork before reconnect.

Observed run:
- workflow: Asset Exchange Bitcoin Regtest;
- run id: `37416646935`;
- source commit: `e44b6681a88a8af6ab3811e390d370389158cce7`;
- conclusion: SUCCESS.

Observed values:
- losing-fork txid: `4cc02c0f5dc2d689c5f6ca608c50f5d98bcb0c7c36c9c5166943934b20cb8803`;
- confirmations before reorg: `2`;
- confirmations after reorg: `0`;
- explicit rebroadcast txid: identical to original;
- reconfirmed on winning chain: `1` confirmation.

This proves, in the isolated two-node regtest scenario, that an application MUST treat confirmation as reversible evidence until the configured confirmation policy is satisfied. A transaction that leaves the active chain is reconciled and the exact same signed transaction can be rebroadcast without constructing a second economic action.


## 9. Refund descendant pinning pressure

The refund RBF harness now includes an adversarial descendant cluster.

Scenario:
1. broadcast a valid low-fee refund parent;
2. attach a high-fee child spending the refund output;
3. attempt a modest parent replacement;
4. require that Bitcoin Core reject the modest replacement because it does not pay enough to evict the parent+child cluster;
5. construct a substantially stronger parent replacement;
6. require that the strong replacement evict both parent and child;
7. continue through confirmation and reorg handling.

Observed run:
- workflow: Asset Exchange Bitcoin Regtest;
- run id: `37416889748`;
- source commit: `e40267d3f7a35919831ff460cc40d69ddbc45a07`;
- conclusion: SUCCESS.

Observed mempool values:
- original refund fee: `0.000002 BTC` (200 sats);
- child fee: `0.000098 BTC` (9,800 sats);
- total evicted cluster fee: `0.000100 BTC` (10,000 sats);
- strong replacement fee: `0.0002 BTC` (20,000 sats);
- original vsize: `131 vB`;
- child vsize: `110 vB`;
- replacement vsize: `131 vB`;
- moderate replacement: rejected;
- strong replacement: accepted.

Observed child txid:
- `13f7e0087f1a47f1e118393ca0e5e47768173b6f7cb0a32ac08d2e6844bba97d`

Observed replacement refund txid:
- `c2af40b08bba167cbd8eadbfc0cf007a9adacbd576f41fa1f0826f11c75042e0`

This demonstrates that refund fee-bump logic cannot reason only about the original transaction fee. It must account for the fee burden of mempool descendants that would be evicted by replacement.

It is still not proof against every larger package/cluster topology.

## 10. Security findings discovered during implementation

### G6-F001 — Preimage length initially enforced only by application
Initial script checked SHA256 preimage equality but did not constrain the preimage byte length on-chain.

Correction:
- added `OP_SIZE 32 OP_EQUALVERIFY` before SHA256;
- Bitcoin Core cross-check retained.

Disposition: FIXED / REGTEST VERIFIED.

### G6-F002 — Prefix-shaped public keys were not guaranteed curve-valid
Initial unit vectors used 33-byte values beginning with 02/03 that were not valid secp256k1 points.

Bitcoin Core rejected the descriptor.

Correction:
- runtime builder now validates compressed keys through Node/OpenSSL secp256k1 point conversion;
- fixtures replaced with real keys derived from Bitcoin Core test WIFs;
- regression test rejects invalid curve points.

Disposition: FIXED / VERIFIED.

### G6-F003 — Raw script signing could not safely construct branch witness
`signrawtransactionwithkey` could create a signature but could not satisfy the arbitrary branch stack automatically.

Correction:
- converted the reviewed script to canonical Miniscript-solvable form;
- refund branch uses the Verify form of the CLTV condition;
- `descriptorprocesspsbt` now constructs and verifies final witness data;
- descriptor output is compared with byte-level P2WSH output.

Disposition: FIXED / VERIFIED.

### G6-F004 — Initial test ordering broadcast funding before refund preparation
The first semantic refund harness broadcast the HTLC before building its refund.

That is not acceptable as production recovery evidence.

Correction:
- added independent recovery-before-lock scenario;
- signed funding remains offline until signed refund and encrypted bundle have been exported and revalidated;
- funding mempool absence is asserted before broadcast.

Disposition: FIXED IN ACCEPTANCE EVIDENCE.

### G6-F005 — Test Base64 tampering was not guaranteed to alter bytes
Changing a final Base64URL character can preserve decoded bytes due to unused encoding bits.

Correction:
- tamper tests flip ciphertext/tag bytes before re-encoding.

Disposition: FIXED.

### G6-F006 — Harness parsing/shell defects
The gates detected and stopped:
- JSON stdin/heredoc collision;
- closed-node HTLC cross-check ordering;
- unclosed shell command substitution.

None were bypassed. Each was corrected and rerun.

Disposition: FIXED.

## 11. What this evidence DOES prove

Within the pinned isolated Bitcoin Core 31.1 regtest environment:
- reviewed P2WSH script and canonical Miniscript descriptor agree;
- correct redeem works;
- incorrect redeem conditions fail;
- CLTV refund timing works;
- refund replacement works in the tested singleton RBF scenario;
- a costly descendant can pin a modest replacement, while a sufficiently funded parent replacement evicts the parent+child cluster;
- redeem/refund confirmations respond safely to forced one-block reorgs;
- two independent nodes can diverge, report UNCERTAIN tips, and converge to the heavier chain;
- a transaction with two confirmations on the losing fork returns to zero confirmations after reorg;
- the exact same signed losing-fork transaction can be rebroadcast with identical txid and reconfirmed;
- exact signed transaction rebroadcast/reconciliation is idempotent;
- a signed refund can be prepared before funding broadcast;
- encrypted recovery material can be exported before funding;
- a refund can execute after the wallet is unloaded.

## 12. What this evidence does NOT prove

STOP-SHIP remains for Mainnet until at least:
- production timeout derivation is reviewed;
- deeper/multi-block reorg matrix beyond the tested two-vs-four-block fork passes;
- deeper package/cluster-limit topologies beyond the tested single-descendant pinning case pass;
- hardware-wallet / external signer compatibility matrix passes;
- standalone recovery tooling is packaged/reproducibly released;
- dependency/SBOM/provenance release evidence is complete;
- liveness/fairness formal model is expanded;
- independent external audit/red-team is completed;
- signet/testnet qualification passes;
- explicit owner authorization is given for any Mainnet canary.

No Mainnet authorization.
No real-funds authorization.
