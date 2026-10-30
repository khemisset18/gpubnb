# DOGE D2: executed diagnostics PASS, full qualification BLOCKED

Owner-authorized D2-only execution run:
https://github.com/khemisset18/gpubnb/actions/runs/40961370001
Commit: 78fa2d1aa889853c8de428004d337bad0b21ddc8.
The reviewed plan/manifest were published first at
acfe2123a8825c7d3595ef70944dccf7ca3cf074 in draft PR #314.

The actual workflow conclusion is **failure**, specifically its final unchanged
qualification gate. Diagnostic execution succeeded; that cannot satisfy the
frozen full-D2 criteria. No expected identity, hash, script vector or acceptance
policy was adapted to an observation.

## Executed and observed

- D0 archive/provenance/SPDX and exact GitHub workflow/repository/owner identities
  revalidated; preserved successful D1 run identity checked without rerunning D1.
- Exact official archive SHA-256 remains
  4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8.
- Exact signed-SPDX native library SHA-256 remains
  3c27dd2f3018a3bd659648129a94ba5f211e84b8ec6d308f7f0db001b5e7902b;
  historical bitcoinconsensus C ABI version1 verified. No new Dogecoin build.
- All23 committed C-ABI valid/invalid cases matched, including one existing
  upstream public signature and its mutation. No signature/key was created.
- All five Solver classifications matched. This is script classification,
  **not full transaction standardness or mempool admission**.
- Exactly1350+1+1 synthetic regtest blocks, to the committed unspendable
  coinbase-only P2SH(OP_RETURN) destination, without a wallet.
- BIP65 reject.status false at1350, true at1351/1352, matching pinned source.
  Explicit C-ABI flag tests are separate from this node activation observation.
- Exact regtest genesis, version1140900 and /Shibetoshi:1.14.9/;
  zero connections/peers before and after, only UP loopback before/after.
- Actual server RPC log contains only seven reviewed methods and ends in stop:
  decodescript5, generatetoaddress3, getblockchaininfo5 (including readiness),
  getblockhash0 once, getnetworkinfo2, getpeerinfo2, stop1.
- Private fresh data, cleared child environment, wallet/P2P/discovery/DNS/UPnP/
  Tor disabled, bounded CPU/memory/disk/time, no wallet files; clean exit0.
- No transaction broadcast, signature creation, D3–D9 operation, public network,
  production service, real funds, deployment or activation.

The old node has no native per-method RPC ACL. The private cookie, sole fixed
harness and loopback-only namespace enforce the operational boundary; the
independent daemon method transcript confirms actual use. This limitation is
retained explicitly rather than described as a native server method firewall.

## Retained proof and blockers

Artifact12935542062, original ZIP SHA-256
8f700c1eaccabf13df6873a4ec1a65931779b0bc231007e3b489615e3d18ebef.
The complete original nine-file evidence ZIP is committed under
`evidence/doge-d2-20261029/`, alongside a readable report, independently checked
summary and SHA256SUMS. It contains only public verification/diagnostic evidence,
not the binary archive, node database, wallet, cookie or GitHub credentials.

**Full D2 remains BLOCKED**: complete standardness/mempool policy and a positive
signature-bound HTLC claim/refund construction have not been demonstrated.
No script/profile is declared qualified, and no capability changes. D0/D1 PASS
remain their original independent evidence gates; GPG upstream provenance is
still distinct. BTC/LTC/BCH/XMR receive no inferred qualification.

The temporary exact-branch/path/unique-message push execution trigger is removed
in this evidence commit; the canonical workflow returns to dispatch-only.
No further node execution is requested or performed by that removal. A future
D2 completion/D3 phase needs separately frozen fixture bytes, exact RPC/signing/
mining/transaction scope and the corresponding owner approval. The expanded D2
permission does not authorize signing or local transaction admission implicitly.
