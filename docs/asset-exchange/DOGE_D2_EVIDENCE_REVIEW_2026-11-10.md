# DOGE consolidated D2 evidence review — 10 November 2026

**Decision: BLOCKED. No qualification promotion, production activation or merge.** This document indexes observations for review; it is not an independent reviewer sign-off. Catalog coverage must not be confused with semantic completeness, production integration or D3–D9 approval.

## Fixed identities and actual runs

- Source: Dogecoin 1.14.9, e0a1c157791544e818c901bd9341896965afbf9d.
- D0 archive SHA256: 4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8; consensus library: 3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b.
- New signed run [42863850857](https://github.com/khemisset18/gpubnb/actions/runs/42863850857), frozen harness 863e905302b1ad34c93f14f6e9aaded9e19ddbfa, execution 030647a43f1b00f7f240f6d09f35636046b5f657. Native experiment PASS: 32 cases, 68 RPCs, 1356 blocks. Full-D2 workflow gate remains failed/BLOCKED.
- Artifact 13786012991 SHA256 0692b3e7957a43126b2d7841bd3252d977b56278b3f663cab219f7b38ad230fc; every internal evidence-file digest verified. Bounded observations: audits/evidence/doge-boundaries-20261110/summary.json. Detailed transaction/RPC archive remains in original Actions storage and local evidence only.
- Separate source-policy diagnostic [42543052508](https://github.com/khemisset18/gpubnb/actions/runs/42543052508), two tests / 26 assertions PASS. Its binary is not D0; see DOGE_POLICY_PROBES_2026-11-09.md.
- Frozen 24-case catalog SHA256 b342a03deb7f4149221964bb984453eed7530365e3f7cf486fd261004af618b5 is unchanged. The 19 native, two source-probe and three software-preflight entries retain their distinct measurement types.

## Catalog mapping

| Criterion | Evidence type | Observation and limit |
| --- | --- | --- |
| valid_claim | NATIVE OBSERVATION | Signature, admission, block confirmation; distinct claim/refund keys. |
| valid_refund_after_lock | NATIVE OBSERVATION | Alias valid_refund_after_crash: persisted before funding, admitted after SIGKILL/reindex and key deletion, confirmed. |
| early_refund | NATIVE OBSERVATION | C ABI accepts; node rejects non-final before required next-block height. |
| equal_candidate_height_nonfinal | NATIVE OBSERVATION | C ABI accepts; node rejects non-final when candidate height equals lock. |
| wrong_signature | NATIVE OBSERVATION | C ABI rejects the signed negative fixture; actual node also rejects script verification. |
| wrong_claim_key | NATIVE OBSERVATION | C ABI rejects the signed negative fixture; actual node also rejects script verification. |
| wrong_refund_key | NATIVE OBSERVATION | C ABI rejects the signed negative fixture; no separate mempool rejection claimed. |
| wrong_secret | NATIVE OBSERVATION | C ABI rejects the signed negative fixture; actual node also rejects script verification. |
| short_secret | NATIVE OBSERVATION | C ABI rejects the signed negative fixture; actual node also rejects script verification. |
| wrong_redeem | NATIVE OBSERVATION | C ABI rejects the signed negative fixture; actual node also rejects script verification. |
| lock_domain_mismatch | NATIVE OBSERVATION | C ABI rejects the signed negative fixture; no separate mempool rejection claimed. |
| changed_signed_lock | NATIVE OBSERVATION | C ABI rejects the signed negative fixture; no separate mempool rejection claimed. |
| wrong_outpoint | NATIVE OBSERVATION | C ABI rejects the signed negative fixture; no separate mempool rejection claimed. |
| wrong_destination | NATIVE OBSERVATION | C ABI rejects the signed negative fixture; no separate mempool rejection claimed. |
| final_sequence | NATIVE OBSERVATION | C ABI rejects; actual node reaches script rejection rather than non-final rejection. |
| wrong_input_value | SOFTWARE PREFLIGHT | test_utxo_outpoint_amount_and_script_mismatch_reject; software preflight only. Legacy sighash does not commit to spent amount. |
| double_spend | NATIVE OBSERVATION | Confirmed spent prevout rejected as bad-txns-inputs-spent. |
| absent_utxo | NATIVE OBSERVATION | gettxout returns null; valid script fixture rejected as Missing inputs. |
| immature_coinbase | NATIVE OBSERVATION | Actual last-block coinbase, one confirmation, valid signature; premature-spend rejection. |
| hard_dust | NATIVE OBSERVATION | Valid signature/script; actual admission rejects dust. |
| soft_dust_reserve | SOURCE DIAGNOSTIC | Run 42543052508: real GetDogecoinDustFee threshold boundaries, additive surcharge and OP_RETURN exemption. |
| dynamic_mempool_fee_floor | SOURCE DIAGNOSTIC | Run 42543052508: forced eviction of one unchecked synthetic pressure entry; exact floor and real admission rejection. Not organic network saturation. |
| excessive_fee | SOFTWARE PREFLIGHT | test_dust_fee_floor_and_user_cap_block_independently; user cap is an offline model, not node fee policy. |
| script_flag_override | SOFTWARE PREFLIGHT | test_promiscuous_flags_can_undermine_even_required_standardness; model rejects override; native run has no override. |

## Broader completion-plan controls

The same native run includes signed amount/sequence mutations, malformed DER, high-S policy, extra stack, nonminimal pushes, non-push-only scriptSig, oversized scriptSig and bare HTLC outputs. These add semantic coverage beyond the frozen inventory without changing that inventory.

Three new deliberately unsafe contracts are funded by actual confirmed 100-DOGE outputs at indexes 4, 5 and 6. The expected script, amount and confirmation are checked before each spend. nLockTime=0 excludes transaction-finality rejection as an explanation:

| Control | C ABI | Node rejection | Independent cross-check |
| --- | --- | --- | --- |
| Negative CLTV operand (OP_1NEGATE) | Reject | non-mandatory-script-verify-flag (Negative locktime) | Refund signature valid for exact malformed redeem and funded prevout |
| Six-byte CLTV operand | Reject | non-mandatory-script-verify-flag (unknown error) | Minimal six-byte operand exceeds the pinned interpreter's five-byte limit; exact refund signature valid. Node wording is retained without inventing a more specific error |
| 16 static P2SH sigops | Accept | bad-txns-nonstandard-inputs | Fourteen CHECKSIGs in an unexecuted branch plus two existing HTLC CHECKSIGs; valid claim signature and matching funded P2SH output |

The production candidate builder still rejects invalid lock values. These unsafe scripts exist only in the private experiment. The original 1360-block, 180-RPC and 32-unique-submitted-fixture bounds are unchanged; 32 case records are not the count of submitted fixtures.

The pre-lock durable refund still survives SIGKILL, removal of ephemeral keys, index reconstruction, and invalidate/reconsider, restoring one confirmation. Separate local byte parsing and Cryptography 50.0.2 ECDSA verification pass for the funding, normal claim/refund and all three new signed fixtures. This verifies their cryptographic binding without importing the harness serializer; it does not replace independent human review.

## Why full qualification is still blocked

1. D2 needs independent semantic review and an explicit versioned script/profile decision. The original C ABI verifies flags 517; full policy evidence comes from actual standardness-enforced admission, not a claim that the C ABI implements all standard flags.
2. D3 still needs signed activation/time-domain/MTP and alternative sighash/malleability coverage. Existing activation diagnostics and height-refund tests are partial evidence.
3. D4/D7 need the actual recovery-envelope and transaction-intent integration, persistence/broadcast fault injection at every boundary, and recovery on an independent host without backend state. Same-process digest retention is not authenticated clean-room recovery.
4. D5 needs realistic bounded relay/eviction, replacement/pinning, fee-bump and rebroadcast scenarios that preserve a valid refund. A forced source-level eviction and a fixed 1-DOGE fixture fee do not qualify production fee management.
5. D6 needs independently configured nodes/watchers, partitions, deeper forks, convergence and AuxPoW handling.
6. D8 requires an explicitly supported external signer profile and displayed-terms verification; no hardware-device test is claimed.
7. D9 requires independent audit/release sign-offs. This implementation session cannot sign itself off as an independent audit.

The latest owner request authorizes continuation of the private qualification work; historical documents describing earlier narrower authorization are not new permission requests. Public-network use, real funds and production activation remain outside these experiments.


## Practical recovery priorities and verified retry

Reuse existing implementations and failure patterns instead of multiplying executors. DCRDEX at fc63460615e8dca83fc19520f32a1cb00be4acfa, client/asset/btc/btc.go, Refund, retries a cached signed refund. Dogecoin at the pinned source, src/rpc/rawtransaction.cpp lines 903–929, recognizes an already-mempool transaction and returns its same txid. This is the reference pattern for the new test, not a claim that DCRDEX has certified this implementation.

| User-visible failure | Required behavior | Current evidence |
| --- | --- | --- |
| App/node crashes after lock | Read the refund saved before funding and recover it after restart | Native private test PASS; independent-host/encrypted-envelope integration remains outstanding |
| Broadcast acknowledgement is lost | Reuse exact persisted bytes; same txid, unchanged fee, one confirmed output | New native test PASS, run 42875442068 |
| Fees become insufficient | Preserve recoverability, expose pending status, and apply only an explicitly bounded safe fee adjustment | Source diagnostic proves floor rejection; end-to-end fee adjustment remains unqualified |
| Transaction disappears after a fork | Return to pending and verify the restored chain state before completion | One-node invalidate/reconsider PASS; multi-node partition/reorg remains outstanding |
| Wrong secret, key, destination or script | Reject the spend | Native signed negative controls PASS |

Run [42875442068](https://github.com/khemisset18/gpubnb/actions/runs/42875442068) uses frozen harness a8b107057e2d48df324ebc6e91cf15615f3fec54 at execution commit 5d5d6fc9825e9b24bea061570982ad77d727a25c. It extends the existing refund-after-crash case without creating another executor. The harness deliberately discards the first broadcast return value and retries the persisted bytes without signing again. It does not inject a physical network outage; it tests the ambiguous-acknowledgement recovery behavior after successful node admission.

All 32 native cases PASS. The downloaded artifact and internal hashes verify; the RPC trace independently shows two successful broadcasts of identical refund bytes, returning the same txid. There is one confirmed output of 99 DOGE, and the mempool fee remains 1 DOGE. Keys were removed before both attempts. Invalidate/reconsider still restores one confirmation. The software suite remains 94 tests PASS. Full qualification remains BLOCKED and the final workflow gate retains that result.

Artifact 13790614781 SHA256 f1db67f4f70cb1e409922bbabb6b58fb3749a3dfabbde9c5b66f1495cfe335e8. Bounded summary: audits/evidence/doge-refund-retry-20261110/summary.json. Detailed transaction/RPC evidence is not republished in git. Temporary trigger retired after capture.

Reference: https://github.com/decred/dcrdex/blob/fc63460615e8dca83fc19520f32a1cb00be4acfa/client/asset/btc/btc.go


## Complément du 11 novembre : remboursement après hausse des frais

Le scénario compilé contre les implémentations natives de Dogecoin est maintenant PASS : ancien remboursement admis puis rejeté après hausse du minimum dynamique, reconstruction sous plafond avec la même sortie, destination, séquence et délai, admission et confirmation du nouveau remboursement. Run 43005573333, trois cas / 60 assertions PASS. Voir DOGE_REFERENCE_IMPLEMENTATIONS_2026-11-11.md pour les références DCRDEX, BasicSwap et decred/atomicswap, les digests et les limites précises. Cette preuve de diagnostic ne remplace pas les validations manquantes de relais, RBF, récupération indépendante et audit.
