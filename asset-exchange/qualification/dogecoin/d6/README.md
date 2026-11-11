# Private Dogecoin two-node laboratory

The initial100-DOGE recovery experiment passed in manual run43052066409 on11November2026:1363 generated blocks,202 shared RPC calls, three-block rollback and standalone backend-hidden recovery. The strengthened native fee scenario passed in run43054425427:1363 generated blocks,206 RPC, native rejection of the0.001DOGE-fee refund and confirmation of the already-signed0.01DOGE-fee variant returning0.99DOGE. Exact artifact digests and bounded summaries are in `docs/asset-exchange/audits/evidence/doge-multinode-20261111/`. Financial qualification and settlement remain blocked.

`multinode.py` reuses the existing D0 archive/member verification, D1 namespace/network identity guards, D2 candidate builder, OpenSSL test signer, transaction codec, consensus-library verifier and recovery-byte reader. It orchestrates two independently configured native nodes rather than implementing another signing or script engine.

## Exact private effects

Both nodes run in a new Linux network namespace with only UP loopback. Peer and RPC ports are fixed; DNS, discovery, UPnP, onion networking and wallets are disabled. Both enforce standardness. Node B deliberately has higher hard-dust and relay-fee limits to test local policy disagreement separately from valid-block consensus.

1. Validate each fresh node against pinned D0/D1 identity; explicitly connect A to B on loopback.
2. Mine and relay 1352 blocks; check BIP65 activation and mature actual funding coinbase.
3. Prepare a100-DOGE claim/conflicting-refund output plus a separate1-DOGE recovery output. Pre-sign recovery refunds with0.001/0.01DOGE fees; cap fees at0.01DOGE and retain at least0.99DOGE. Durably write and read back the immutable recovery JSON before funding. Monetary JSON fields are canonical decimal strings.
4. Broadcast funding on A; prove B observes its mempool entry and both nodes independently confirm the same funding output.
5. Delete all four ephemeral signing keys. Broadcast a dust-policy control accepted by A and rejected by B, then prove B accepts the valid block containing that transaction.
6. Partition B. A mines a claim on one fork; B mines the conflicting refund on a longer fork. Capture independent observations of the differing tips.
7. Reconnect and require convergence to the same exact best hash at height1359. A rolls back three blocks. Its former claim may no longer be marked confirmed; the competing refund is independently confirmed by both nodes.
8. Check the native post-activation block's AuxPoW flag, chain ID98 and AuxPoW JSON evidence. Adversarial malformed-parent/merkle AuxPoW tests remain outside this experiment.
9. With all signing keys gone, submit the cheaper pre-signed refund to B, require its native insufficient-priority rejection and mempool absence, then run the standalone tool. Its observed0.01DOGE/kB relay floor must select the already-signed0.01DOGE-fee variant. Prove exact bytes, destination,0.99DOGE recovered, mempool relay and confirmations independently on A and B at height1360. This is selection after rejection, not replacement of a pending transaction.
   An additional regression scenario now re-relays this already-pending higher-fee variant through node A, whose lower floor would also allow the cheaper variant. It must keep the pending transaction's identity and exact bytes. This additional case remains NOT_TESTED natively until the next manual run.
10. Restart A cleanly and verify exact winning tip and refund confirmation after reconnection.

The optional standalone-recovery hook additionally observes confirmation, local invalidate/reconsider rollback and reconfirmation through the separate recovery environment. Its calls share the fixed RPC budget. A baseline execution without that hook explicitly reports independent recovery as NOT_TESTED.

## Bounds

Two nodes; at most1370 generated blocks across forks;480 RPC calls including independent recovery;8 unique submitted fixtures;10000 bytes per fixture;900 seconds wall time;600 CPU seconds and2GiB address space per process;1024MiB combined node data; at most one loopback peer per node. No Mainnet, public peers, real funds or production keys are involved.

## Manual execution

`.github/workflows/asset-exchange-dogecoin-multinode.yml` launches the experiment remotely only from an original `workflow_dispatch` event, directly or through the registered `workspace-reliability.yml` manual entry. The latter offers both/D3/multinode selection on this exact development branch. No push, PR or schedule can execute either native job. Exact execution/reviewed harness commits and `AUTHORIZE_D6_PRIVATE_MULTINODE_REGTEST` are checked before loading native code.

The wrapper `run-multinode.sh` first calls `../d0/verify-runtime-evidence.sh` to reverify the preserved D0/D1 Actions identities and both signed D0 attestations. The shared helper itself never loads Dogecoin. Native processes and ephemeral keys exist only after the namespace boundary has been verified.

`check-watcher-evidence.mjs` applies the strict Dogecoin observation adapter to the captured paired native observations. Diverging tips, missing/stale observations and confirmed competing spends stop progression. The adapter always returns settlementAllowed=false. Historical evidence is evaluated at its captured time and never presented as live observations.

## Recovery integration API

`run(args, recovery_runner=None, bundle_validator=None)` supports a caller-owned standalone recovery package. `bundle_validator(bundle)` runs before the immutable JSON is persisted and before funding is broadcast.

`recovery_runner(context)` receives the public bundle path and independently passed SHA256, verified D0 CLI path/digest, selected private node connection arguments/port/data-directory, paths that the clean-room environment must hide, and the original network/mount namespace identities. It is called at most five times: rebroadcast through B; re-relay pending through A at the lower fee floor; observe CONFIRMED through B; observe PENDING with REORGED transition after a local block invalidation; observe CONFIRMED after reconsideration. Each endpoint keeps its own copied cookie and journal; the B journal is reused for reorg detection.

Every hook returns `{txid,state,transition,rpcCalls,isolationProof}`. `rpcCalls` contains only current-invocation `{method,params}` rows with canonical string parameters, at most64. No credentials belong in this result or the artifacts. The laboratory reconciles the exact server RPC-method counts against its own calls plus the independent calls. The hook itself must enforce its64-call limit before executing each request.

The immutable bundle carries only public contract/funding/refund transactions and bounded policy; no original private keys, wallet seeds, RPC passwords or cookies. The funding block anchor is observed after confirmation and stored separately in evidence, never guessed into a pre-lock immutable bundle.

## Current validation

Both native artifacts were downloaded and checked against their Actions SHA256. Every internal evidence digest, public refund signature/terms, native server RPC-method counter and observation confirmation-height relation was checked again locally. Recovery transitions were PENDING→CONFIRMED→REORGED→CONFIRMED. The latest additional falling-floor pending re-relay case remains NOT_TESTED until the next manual run; offline guards alone do not prove it.

Pinned Dogecoin1.14.9 source explains the1-DOGE fee fixture: `src/validation.cpp:788–815` checks rolling mempool fees and relay priority; `src/txmempool.h:47–56` defines free priority; `src/rpc/rawtransaction.cpp:897–909` uses `fLimitFree=false`. A100-DOGE aged input can bypass the simple relay-priority rejection, so a claim that merely raising minrelaytxfee always rejects it would be false. No upstream behavior is modified for this test.
