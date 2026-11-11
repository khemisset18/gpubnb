# Private Dogecoin two-node laboratory

Prepared executable experiment, not yet native-executed. Financial qualification and settlement remain blocked.

`multinode.py` reuses the existing D0 archive/member verification, D1 namespace/network identity guards, D2 candidate builder, OpenSSL test signer, transaction codec, consensus-library verifier and recovery-byte reader. It orchestrates two independently configured native nodes rather than implementing another signing or script engine.

## Exact private effects

Both nodes run in a new Linux network namespace with only UP loopback. Peer and RPC ports are fixed; DNS, discovery, UPnP, onion networking and wallets are disabled. Both enforce standardness. Node B deliberately has a higher hard-dust limit to test local relay-policy disagreement separately from valid-block consensus.

1. Validate each fresh node against pinned D0/D1 identity; explicitly connect A to B on loopback.
2. Mine and relay 1352 blocks; check BIP65 activation and mature actual funding coinbase.
3. Prepare claim, conflicting refund and two recovery refunds with fees of 1/2 test DOGE. Durably write and read back the immutable recovery JSON before funding. The recovery funding is 100 DOGE, its fee cap is 2 DOGE and minimum refund is 98 DOGE. Monetary JSON fields are canonical decimal strings.
4. Broadcast funding on A; prove B observes its mempool entry and both nodes independently confirm the same funding output.
5. Delete all four ephemeral signing keys. Broadcast a dust-policy control accepted by A and rejected by B, then prove B accepts the valid block containing that transaction.
6. Partition B. A mines a claim on one fork; B mines the conflicting refund on a longer fork. Capture independent observations of the differing tips.
7. Reconnect and require convergence to the same exact best hash at height1359. A rolls back three blocks. Its former claim may no longer be marked confirmed; the competing refund is independently confirmed by both nodes.
8. Check the native post-activation block's AuxPoW flag, chain ID98 and AuxPoW JSON evidence. Adversarial malformed-parent/merkle AuxPoW tests remain outside this experiment.
9. Recover a separate funding output through node B from saved public refund bytes; prove mempool relay and confirmations independently on A and B at height1360.
10. Restart A cleanly and verify exact winning tip and refund confirmation after reconnection.

The optional standalone-recovery hook additionally observes confirmation, local invalidate/reconsider rollback and reconfirmation through the separate recovery environment. Its calls share the fixed RPC budget. A baseline execution without that hook explicitly reports independent recovery as NOT_TESTED.

## Bounds

Two nodes; at most1370 generated blocks across forks;480 RPC calls including independent recovery;8 unique submitted fixtures;10000 bytes per fixture;900 seconds wall time;600 CPU seconds and2GiB address space per process;1024MiB combined node data; at most one loopback peer per node. No Mainnet, public peers, real funds or production keys are involved.

## Manual execution

Only `.github/workflows/asset-exchange-dogecoin-multinode.yml` may launch the experiment remotely, via `workflow_dispatch`. It has no push or pull-request trigger. The operator must supply the exact execution commit, reviewed harness commit and `AUTHORIZE_D6_PRIVATE_MULTINODE_REGTEST`. The workflow verifies repository/branch identity and requires all executable sources, their shared helpers and the workflow itself to match the reviewed harness before loading native code.

The wrapper `run-multinode.sh` first calls `../d0/verify-runtime-evidence.sh` to reverify the preserved D0/D1 Actions identities and both signed D0 attestations. The shared helper itself never loads Dogecoin. Native processes and ephemeral keys exist only after the namespace boundary has been verified.

`check-watcher-evidence.mjs` applies the strict Dogecoin observation adapter to the captured paired native observations. Diverging tips, missing/stale observations and confirmed competing spends stop progression. The adapter always returns settlementAllowed=false. Historical evidence is evaluated at its captured time and never presented as live observations.

## Recovery integration API

`run(args, recovery_runner=None, bundle_validator=None)` supports a caller-owned standalone recovery package. `bundle_validator(bundle)` runs before the immutable JSON is persisted and before funding is broadcast.

`recovery_runner(context)` receives the public bundle path and independently passed SHA256, verified D0 CLI path/digest, node-B connection arguments/port/data-directory, paths that the clean-room environment must hide, and the original network/mount namespace identities. It is called at most four times: rebroadcast; observe CONFIRMED; observe PENDING with REORGED transition after a local block invalidation; observe CONFIRMED after reconsideration. The same clean-room journal must be reused.

Every hook returns `{txid,state,transition,rpcCalls,isolationProof}`. `rpcCalls` contains only current-invocation `{method,params}` rows with canonical string parameters, at most64. No credentials belong in this result or the artifacts. The laboratory reconciles the exact server RPC-method counts against its own calls plus the independent calls. The hook itself must enforce its64-call limit before executing each request.

The immutable bundle carries only public contract/funding/refund transactions and bounded policy; no original private keys, wallet seeds, RPC passwords or cookies. The funding block anchor is observed after confirmation and stored separately in evidence, never guessed into a pre-lock immutable bundle.

## Current validation

Python safety guards, shell syntax and JavaScript watcher regressions are offline preparation. They do not substitute for the pending manually dispatched native experiment. No native effects, dispatch, remote writes or financial qualification promotion are performed by this implementation commit.
