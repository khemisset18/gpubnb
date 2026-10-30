# DOGE D2 script diagnostics — reviewed execution boundary

Status before execution: **PREPARED**. Full D2 qualification remains **BLOCKED**.
The owner's expanded authorization attached on 29 October 2026 authorizes this
D2-only disposable regtest experiment and the synthetic blocks strictly needed
to examine CLTV activation. It does not authorize D3–D9 execution, signing,
wallet use or transaction submission. The harness never calls those operations.
The final workflow gate must fail if only diagnostics have succeeded.

## Frozen inputs and pre-execution gates

- Exact original Dogecoin source: `e0a1c157791544e818c901bd9341896965afbf9d`.
- Existing D0 success run `40866305437`, attempt 1, build commit
  `99724d5b66b9475dcb96f6c471c75ce01ed60f9a`; no rebuild is performed.
- Exact official archive SHA-256:
  `4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8`.
- Exact packaged regular library member
  `dogecoin-1.14.9/lib/libdogecoinconsensus.so.0.0.0`, SHA-256
  `3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b`.
  Its digest and both executable digests must also match the **signed** SPDX.
- Recheck D0 and D1 successful run identity, attempt, exact commit, repository ID
  1305325878 and owner ID 103233875. D1 run is `40892872892`, commit
  `1636df354d4fafd2cc2d9ab8595f4dca52582ad7`; D1 is not re-executed.
- `gh attestation verify` checks both D0 provenance and SPDX against the unchanged
  exact workflow, source commit/ref, signer digest and GitHub-hosted identity.
  D1's existing strict certificate/subject/predicate validation is reused without
  changing it. Missing signature, wrong identity, hash, library or file stops D2.
- `operations-manifest.json` enumerates every native verification input and RPC
  fixture. The harness prints its exact effective manifest **before** loading
  Dogecoin code. An offline regression compares it to the committed manifest.

The archive's historical C ABI uses **bitcoinconsensus** names despite the
`libdogecoinconsensus` filename: version 1, `bitcoinconsensus_version` and
`bitcoinconsensus_verify_script`. This is checked against the pinned header,
not guessed from outdated shared-library prose. No compiler/new Dogecoin build
is introduced.

## Isolation and resources

One fresh Linux network namespace, only UP loopback, checked before native code
and after shutdown. No external interface or Core network access. A cleared
child environment contains PATH/LANG only. One new private 0700 parent holds
separate executable, data and public-evidence directories. Wallet, P2P, DNS,
peer discovery, UPnP and Tor are disabled; RPC binds only 127.0.0.1 and uses the
node's private cookie. The release lacks native per-method RPC ACLs: the sole
fixed-command harness and private isolated namespace enforce method selection;
the actual server method log is checked independently.

Bounds: one node, 1352 generated regtest blocks total, three generation calls,
one million PoW tries per call, 600-second harness alarm, 15-minute CI job,
420 CPU seconds per process, 2 GiB address-space limit per process, 512 MiB
single-file/data budget, 64 MiB node DB cache and one script-verification worker.
No wall-clock/consensus parameter or trusted snapshot is changed. Failure never
causes an automatic retry with looser expectations.

## Effective RPC list and exact restrictions

| RPC | Parameters and purpose |
| --- | --- |
| `getblockchaininfo` | No parameters. Readiness, fresh genesis identity, then exact heights and BIP65 status. |
| `getblockhash` | Only `0`; exact regtest genesis `3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5`. |
| `getnetworkinfo` | No parameters; version 1140900, `/Shibetoshi:1.14.9/`, zero connections before/after. |
| `getpeerinfo` | No parameters; empty list before/after. |
| `decodescript` | Only five committed script hex fixtures: P2PK, P2PKH, candidate P2SH output, candidate HTLC redeem and bare CLTV control. |
| `generatetoaddress` | Exactly counts `1350`, `1`, `1`, fixed burn destination `2MyF5LxGTsXxf7xSpLr6RqXD4N7f1uEBfS7`, maxtries `1000000`, auxpow `0`. |
| `stop` | No parameters, final server RPC; clean exit 0 required. |

The burn destination is regtest Base58Check P2SH of the one-byte OP_RETURN
redeem script `6a`, not a wallet address with a known spending key. Coinbase
outputs are synthetic and cannot be spent through that script. Address prefix
196 is read from the exact regtest source. No wallet is created or loaded.

The 1350+1+1 schedule measures source-expected BIP65 `reject.status` false at
height 1350 and true at 1351/1352. The final block is the smallest after-boundary
control. It does not test signed timelock spends. Source permits nonlegacy
normal PoW blocks after AuxPoW activation; `auxpow=0` is not an AuxPoW test.
No CSV/witness assumption or capability is introduced.

## Native verification and expected results

23 predeclared C-ABI vectors cover true/false controls; P2SH before/after its
explicit flag; exact/mismatched redeem hash; CLTV flag absent/present and
before/equal/after lock value; final sequence, height-vs-time and negative-value
rejection; P2SH CLTV; correct/wrong public hashlock preimage; rejection of a
candidate HTLC claim/refund without signatures; malformed transaction and input
index; one existing upstream public signature and its mutation. No signature is
created. The exact public transaction comes from JSON row 73 of pinned
`src/test/data/tx_valid.json`; provenance, file hashes and MIT copyright/license
are retained in `source-fixtures.json` and `DOGECOIN_COPYING`.

These explicit flag tests exercise the actual packaged script interpreter.
They do **not** prove transaction finality, positive HTLC claim/refund viability,
chain activation under every consensus condition, or a complete swap.

## PASS / FAIL / BLOCKED semantics

- **Diagnostic PASS** requires all predeclared C-ABI observations, Solver output
  types, identity, activation heights, exact generation budget, zero peers,
  loopback-only interfaces, wallet-file absence, method transcript and clean
  shutdown to match. Any unexpected result is **FAIL**, with no adaptation of
  expected identities or vectors to observed output.
- **Full D2 BLOCKED** remains mandatory: `decodescript` calls Solver and reports
  output classification, not full `IsStandardTx`/mempool policy. Regtest defaults
  do not require standardness. No `sendrawtransaction`, signing or positive
  signature-bound HTLC spend/refund was authorized in this scope. The frozen D2
  gate requires those additional proofs before selecting a qualified profile.
- The workflow uploads evidence even on failure, then enforces a separate full
  qualification gate. Diagnostic PASS therefore cannot make the D2 workflow
  falsely green. No capability, production setting or automatic settlement
  state is changed.

Evidence contains the effective manifest, source/fixture hashes, revalidated
run and attestation results, observed chain/activation state, script-vector and
Solver results, bounded RPC requests plus result hashes/errors, daemon RPC log,
namespace inventory and clean shutdown. Cookie files, node data, executable
copies and any private GitHub environment are never uploaded. Original logs
may need lossless gzip preservation before they are added to Git, as in D1.

## Future permission boundary

A future D2 completion or D3–D9 execution must name exact separately reviewed
fixtures/RPCs and any synthetic signing/transaction operations. This plan grants
no such extension. BTC stays in its established regtest scope; LTC, BCH and XMR
receive no qualification through these DOGE observations.
