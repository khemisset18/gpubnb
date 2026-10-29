# DOGE D1 isolated network identity — authorized execution plan

Status: **AUTHORIZED FOR D1 ONLY / EXECUTION PENDING / D1 UNQUALIFIED UNTIL EVIDENCED**.
D0 source-rebuild passed in run 40866305437. The owner has now given separate explicit authorization for this exact D1
phase. That permission does not extend to any D2-D9 execution.
No Mainnet, wallet, mining, transaction broadcast, real funds or activation is
part of this phase. D2-D9 remain outside this execution request.

## Reviewable execution boundary

The prepared manual workflow is
`.github/workflows/asset-exchange-dogecoin-d1-manual.yml`. Manual execution
requires the exact input `AUTHORIZE_D1_ISOLATED_REGTEST`. For this approved
execution only, a temporary push trigger is bound to this work branch, this
workflow path and the exact execution commit message. GitHub requires a dispatch
workflow to exist on the default branch; changing main is forbidden. This
branch-only trigger executes the already authorized phase without changing main
and must be removed after collecting the result. See the authorization record
below. A rejected identity or isolation check still blocks execution.

1. Download the already verified D0 evidence from run 40866305437, code commit
   `99724d5b66b9475dcb96f6c471c75ce01ed60f9a`.
2. Cryptographically verify both Sigstore attestations, exact source/signer
   commit, authorized branch, workflow and GitHub-hosted identity. Recheck
   repository/owner IDs, this D0 run, subject digest and exact signed SPDX.
3. Require the unchanged official archive SHA-256
   `4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8`.
4. Create a new Linux network namespace with **only loopback**, bring loopback
   up and verify it differs from the host namespace. No external interface,
   peer or Core RPC/service is reachable from this namespace.
5. Use a fresh private data directory and explicit configuration, regtest,
   `testnet=0`, loopback RPC, fixed RPC port 18332, wallet disabled, P2P/listen,
   discovery, DNS seeds, UPnP and onion listening disabled. Clear inherited
   environment before the node is started. No Core credentials or defaults.
6. Invoke only `getblockchaininfo`, `getblockhash 0`, `getnetworkinfo`,
   `getpeerinfo`, then local node `stop`. The harness allowlist rejects wallet,
   mining and broadcasting methods before invocation. This old node has no
   server-side method ACL: private cookie authentication and the otherwise
   empty namespace restrict access to the fixed-command harness. RPC debug
   logging must confirm the exact allowed server methods after clean shutdown.
7. Require a genesis-only fresh chain, correct release/version, zero
   connections and no peers; stop the node cleanly before recording D1 PASS.
8. Upload only verification outputs and public evidence. Do not upload the
   private data directory, executable copies, cookies or wallet files.

The input artifact expires on 2026-11-28. After expiry the workflow must fail;
do not silently substitute another artifact, source or trusted run. The saved
D0 proof bundle can support a separately reviewed equivalent handoff.

## Approved source-derived identity expectations

These values are taken from the **existing** trusted source commit
`e0a1c157791544e818c901bd9341896965afbf9d`, not borrowed from Bitcoin:

| Candidate check | Exact value / source |
| --- | --- |
| Network | `regtest`, `src/chainparams.cpp`, `CRegTestParams` |
| Genesis | `3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5` |
| Client integer version | `1140900`, `src/clientversion.h` |
| Client subversion | `/Shibetoshi:1.14.9/`, source client name/release version |
| RPC port | `18332`, `src/chainparamsbase.cpp`, `CBaseRegTestParams` |

Inspected `src/chainparams.cpp` SHA-256:
`150d3733903d05f22e2ce3bc195a65f99ced183e16f2e75f52a72d0df8ec5d9c`.
Inspected `src/clientversion.h` SHA-256:
`a76ba00af7048cb903d1e4c394d1302a53633a4a5037f7f686f1c09f992654ad`.
The pinned CLI prints string RPC results without JSON quotes, as shown by
`src/bitcoin-cli.cpp:326-329`; the prepared harness handles this explicitly.

These are D1 test expectations only. No production network identity, registry,
capability, D0 trust input or acceptance threshold has been changed.

## Verification completed before requesting execution approval

- Ten offline adversarial D1 tests pass: reject wrong network/genesis/version,
  stale/nonfresh chain, boolean counters, connections/peers, missing or altered
  D0 identity, mismatched signed SPDX, missing authorization and prohibited RPCs.
- The handoff validator accepts the actual independently verified D0 bundles.
- All 31 D0 tests and 150 Asset Exchange tests pass locally, with no skips.
- Bash, workflow YAML and embedded Bash syntax pass.
- Foundation CI now includes an empty-network-namespace preflight without any
  Dogecoin process. Its result is an isolation check, not a D1 qualification.

No real D1 observation or success is claimed until the authorized
isolated execution completes. Any signature, namespace, genesis, version or
shutdown mismatch is a failure, with no fallback to another network or policy.

## Owner authorization record — 2026-10-29

The current mission expressly states: “Je t’autorise séparément à exécuter
uniquement le binaire Dogecoin Core v1.14.9 déjà reproduit et vérifié, dans
l’environnement regtest entièrement isolé prévu par le plan D1.”

Scope: existing verified D0 artifact; network identity RPCs and clean stop only;
no public network, wallet, mining, transaction, real funds or settlement. D2-D9
need separate specific approval. This records permission, not a D1 PASS.
