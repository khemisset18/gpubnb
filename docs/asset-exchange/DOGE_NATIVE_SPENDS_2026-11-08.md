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
