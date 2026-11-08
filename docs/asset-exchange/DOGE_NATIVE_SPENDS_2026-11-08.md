# Private signed Dogecoin experiment — 8 November 2026

User explicitly authorizes development, ephemeral test keys/signatures, private mining and transaction submission. No real funds, public blockchain connection, deployment or merge. The previous diagnostic-only authorization is not reused to imply that signatures were already tested.

## Exact experiment

New `qualification/dogecoin/d2/native_spends.py` and `run-native-spends.sh` reuse the original D0 archive SHA256, signed provenance, signed SPDX and member validation. Only a fresh, separate Linux namespace with one UP loopback interface can reach key generation or native loading. The signer is OpenSSL secp256k1 ECDSA; keys stay in private runner storage and are removed before recovery. Removal is not claimed as physical secure erasure. No wallet is enabled.

One Dogecoin 1.14.9 process, max 1360 synthetic blocks, max 180 RPC requests, max 32 registered transaction fixtures, max 600 seconds, 2 GiB address space, 512 MiB data. RPC binds to loopback; P2P/DNS/discovery/Tor disabled. `acceptnonstdtxn=0`; no promiscuous flag override. Source at e0a1c157791544e818c901bd9341896965afbf9d: init.cpp sets fRequireStandard from that flag; validation.cpp enforces IsStandardTx, AreInputsStandard and STANDARD_SCRIPT_VERIFY_FLAGS. C ABI flags are reported separately and are not asserted equivalent to all standard policy flags.

Mine 1352 blocks to one ephemeral miner key; verify genesis/version/zero peers and active BIP65; spend a mature coinbase into four 100-DOGE HTLC outputs with distinct claim/refund keys and change. Synthetic funding fee: 1 DOGE; claim/refund fees: 1 DOGE. Lock height 1355. Signatures use legacy SIGHASH_ALL only and low-S DER. Persist only public transactions, signatures, keys and revealed synthetic preimage.

Required experiment assertions: valid funding/claim/refund signatures, wrong keys/preimage/length/outpoint/signed lock, lock domain, final sequence, early/equal-candidate refund finality, hard dust and nonminimal push policy rejection, mempool acceptance and spent UTXOs, conflicting spend rejection, actual SIGKILL/restart followed by refund from persisted signed bytes with signing keys removed, invalidate/reconsider refund block and chain UTXO restoration. Rejection reasons are checked, not merely any RPC error.

## Acceptance and limits

`experimentStatus=PASS` requires every implemented assertion. `qualificationStatus=BLOCKED` remains unconditional because the complete frozen 24-case matrix, dynamic mempool pressure, soft-dust instrumentation, independent review and all D3–D9 scenarios are not covered. An assertion failure stays FAIL and retains evidence. No existing test, scenario matrix, capability, financial route or qualification gate is weakened.

Offline validation before first execution: 84 D2 tests, including ten new signer/isolation/manifest controls. OpenSSL signatures are independently verified with OpenSSL; this alone is not native Dogecoin signature proof. The node execution must provide that proof.

## Research informing implementation

- Decred Bison/DCRDEX `client/asset/doge/doge.go`, snapshot fc63460615e8dca83fc19520f32a1cb00be4acfa: distinct DOGE adapter, soft dust threshold and DOGE-specific fees. Reuse of Bitcoin-shaped transaction structures does not imply identical policy. No third-party code copied.
  https://github.com/decred/dcrdex/blob/fc63460615e8dca83fc19520f32a1cb00be4acfa/client/asset/doge/doge.go
- COMIT BTC–XMR README explicitly warns that its cryptography has not been formally audited and warns about fee-bumping side effects. Publication or working software is not our security qualification.
  https://github.com/comit-network/xmr-btc-swap
- The published BTC–XMR protocol uses a distinct construction for Monero; it must not inherit Bitcoin HTLC flags or scripts.
  https://arxiv.org/abs/2101.12332
- Eigenwallet and BasicSwap are implementation references, not automatic audit endorsements. Their own security and maintenance claims must be verified against a specific version/audit scope before integration.
  https://github.com/eigenwallet/core
  https://github.com/basicswap/basicswap

Avoid: conflating source claims with runtime evidence, default-regtest policy bypass, legacy signatures treated as input-amount commitments, lock equality treated as finality, silent fee mutation, stale UTXO evidence, shared participant keys, and recovery depending on backend key custody.

## First native execution, retained FAIL

Run 42424163266 at 772041f232bb160af7b64c0b880d50f3b654f171 reached a confirmed valid claim and all preceding controls, then failed the expected error-string assertion for the confirmed double spend. Actual node error: -26 / 18: bad-txns-inputs-spent; expected incorrectly: Missing inputs (-25, missing parent). Dogecoin validation.cpp distinguishes these branches. The native transaction was rejected, not accepted. Correct the assertion and add code/reason regressions; preserve the original FAIL. Refund/restart/reorg were not reached in this first run.

Artifact 13595260005 ZIP SHA256: 624dd32c258f05637c914e37c57be285fb9ad768b45bbd8f41d75b7d041065f3. Independently downloaded and hash-checked. Its complete bytes are retained alongside subsequent evidence; no signature result is inferred from a software model.

## Second native execution, retained FAIL

Run 42424472851 at fb790f56c74485dce39e8cb55d964fbe34042761 passed the spent-input rejection but exposed restart at genesis after SIGKILL: index on disk still described one block while blk data had the newly mined blocks. Artifact 13594912323 ZIP SHA256 d1a3afa469288fabdc71f93b9c6efda3df7939b4eed8c441407da5d5c311792b independently verified. No refund broadcast/reorg was reached.

Recovery now retains the observed stale tip, rebuilds the disposable local index with source-supported -reindex (init.cpp ThreadImport / LoadExternalBlockFile), and requires the exact prior tip hash and height plus refund script/value/confirmations before broadcast. No remine, no public synchronization, no lowering confirmations. Public signed bytes are fsynced with their parent directory before keys are removed. This is a process-crash experiment, not power-loss durability qualification.

## Third native execution, retained FAIL

Run 42424908068 at c002d552082a3a007b0200dd40224ce0e1c3a10e failed to restore the prior tip by reindexing after a normal startup. Artifact 13594434879 ZIP SHA256 fb235f7cdf819d0375b5aeef998507e58a6ae5351bb07a3cc988ed7c46a4c161 independently verified. The reindex log reports only one block loaded. Existing evidence does not prove whether the normal restart altered block storage or the original records were already absent.

Next experiment inspects framed block records and requires the exact prior header hash on disk immediately after SIGKILL, before any restart. It records count and SHA256, then starts directly with -reindex and reindex diagnostics. Exact height/hash and refund UTXO requirements remain unchanged. A missing block record stops before restart; this is diagnostic evidence, not assumed recovery success.

## Fourth execution: native experiment PASS, complete D2 BLOCKED

Run 42425569513 at 40908d22a0640c6f8df70efb638296779995ebf5: native experiment step PASS; final full-D2 gate FAIL by design (qualification BLOCKED). Artifact 13595650348 ZIP SHA256 103c15b6d7798173fe392aa7d0db4904379d3aa38807cbeb11a326a06b91769d independently matches upload digest; all internal SHA256SUMS entries verified.

Sixteen native cases, 47 RPC calls, 1356 generated blocks. After SIGKILL (-9), 1356 framed records including genesis and the exact prior tip are present on disk. Immediate reindex restores exact height 1355/hash d48ad7190813c011677c5852debf2486ed645b87406221a38bab9ef1458ad38a. The 100-DOGE refund input has three confirmations and exact expected script. Previously signed refund is admitted and confirmed after private key removal. Invalidation restores its chain UTXO and mempool entry; reconsideration restores one confirmation. Final daemon stop returns zero, zero peers, loopback-only namespace and no wallet/key residue. This proves the implemented private process-crash scenario, not general power-loss or multi-node recovery.

Next frozen extension adds the matrix's wrong signature, wrong redeem, wrong destination, absent UTXO, and immature coinbase cases. Signature failures are distinct from a valid signature rejected for missing or immature input. Resource/RPC/network budgets and full D2 gate are unchanged.

## Fifth execution: expanded native experiment PASS

Run 42512160122 at 21aad6bab1e049a01c1dcc0d92749252fa68138a, frozen harness 8e41cbda5829ab41fa77b7c0203ab5a8882aa1e1. Artifact 13629588765 SHA256 94f6afeae4ffbd7e5087e5758ca8a0de9067c6beed7c1168f4393d5343a6326d. Archive digest and every internal SHA256SUMS entry independently verified. Native step PASS; overall workflow FAIL because the complete-D2 gate remains BLOCKED.

21 actual C-ABI cases, 54 RPC calls, 1356 generated blocks, 88 offline tests PASS. All five added adversarial cases give their required results. Immature coinbase has one confirmation and a valid script signature, but admission rejects with -26 / bad-txns-premature-spend-of-coinbase. Absent input has a valid signature for the synthetic script, gettxout returns null and admission rejects with -25 / Missing inputs. Wrong signature/redeem are rejected by script validation; changed destination fails native signature verification. Recovery, refund confirmation and invalidate/reconsider pass again. No private keys, cookies, wallet or node data are included in archived artifacts.

All five complete ZIPs, including the three FAIL attempts, are retained locally and in their original GitHub workflow artifacts. Only the separate SHA256SUMS inventory is committed under audits/evidence/doge-native-20261108. Archive retention in Actions is 30 days; the local copies preserve the original downloaded bytes. Automated approval review rejected republication of the detailed archives in the repository; no archive or detailed RPC dump is included in this final publication. The fourth run's positive funding/claim/refund signatures were also parsed independently from raw transaction bytes and verified with cryptography 50.0.2 secp256k1 ECDSA, legacy SIGHASH_ALL and low-S checks; this is a second parser/provider path, not an independent human audit.

The temporary exact-branch push trigger is removed. Manual dispatch retains exact repository/branch gating and frozen harness comparison; full fetch history keeps that comparison valid after documentation commits. Existing signed D0 provenance and full D2 gate are unchanged.

## Remaining acceptance gaps, not waived

The 21 executed records include funding and nonminimal-push controls in addition to the 19 NATIVE_CORE scenario identities in the frozen 24-case inventory (`valid_refund_after_crash` corresponds to `valid_refund_after_lock`). Matching identities is not automatic proof of every semantic subcriterion: C-ABI flags 517 are only P2SH/DERSIG/CLTV, and positive admission supplies the additional node policy evidence.

| Frozen inventory item | Evidence status | Remaining requirement |
| --- | --- | --- |
| 19 NATIVE_CORE identities | Native observations retained | Independent review and indexing of every expected script/finality/UTXO/policy result |
| wrong_input_value | Offline preflight tests PASS | Bind exact expected intent value to the native report; legacy signature does not commit input amount |
| excessive_fee | Offline preflight tests PASS | Bind explicit user cap to the fixture manifest; node cap is a different rule |
| script_flag_override | Offline preflight tests PASS | Preserve source-pinned standardness/no-override checks |
| soft_dust_reserve | NOT_TESTED natively | Source-pinned native GetDogecoinDustFee instrumentation; sendrawtransaction does not exercise the free-relay surcharge path |
| dynamic_mempool_fee_floor | NOT_TESTED natively | Separately frozen bounded pressure fixture and observed rolling floor/rejection |

The broader completion plan also requires adversarial limits/flags beyond this inventory (noncanonical signature, extra stack, bare HTLC, non-push-only or oversized scriptSig, excess sigops, negative/oversized lock operand and before-activation behavior with distinct signed participants). Historical diagnostic controls are not silently promoted to full signed-spend coverage. Multi-node/deeper reorg and power-loss durability remain outside this one-node process-crash experiment. D2 BLOCKED; D3–D9 BLOCKED; all 20 exchange directions BLOCKED. No financial activation, deployment or merge is performed.
