# DOGE D1 — isolated network identity PASS

**TERMINÉ ET PROUVÉ**, network identity only. This is not settlement or production
qualification. Explicit owner authorization covered this exact D1 execution.

- Successful run: https://github.com/khemisset18/gpubnb/actions/runs/40892872892
- Execution commit: `1636df354d4fafd2cc2d9ab8595f4dca52582ad7`.
- Artifact: `12906020927`; ZIP SHA-256
  `18fecb1f6dd6dac59a44d44a351ddd7f70e378dd5f189a055d9af19c1002f13b`.
- Exact D0 run 40866305437 attempt 1 was rechecked successful at commit
  `99724d5b66b9475dcb96f6c471c75ce01ed60f9a`, repository 1305325878,
  owner 103233875. Both Sigstore bundles were cryptographically verified by
  `gh attestation verify` with exact hosted workflow/source/signer/ref checks;
  signed SPDX matched exactly. No D0 trust input was changed.
- The executed archive's SHA-256 remained the official
  `4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8`.

## Actual observations

| Check | Result |
| --- | --- |
| Namespace | distinct Linux namespace `net:[4026532221]`, only UP loopback before and after execution |
| Fresh chain | regtest, blocks 0, headers 0 |
| Genesis and best block | `3d2160a3b5dc4a9d62e7e66a295f70313ac808440ef7400d6c0772171ce973a5` |
| Release | version 1140900; `/Shibetoshi:1.14.9/` |
| Peers / connections / local addresses | empty / 0 / empty |
| Tor | onion limited, unreachable, no proxy |
| Wallet | explicit disablewallet; log `Wallet disabled!`; no wallet files |
| RPC | loopback 127.0.0.1:18332, private random cookie, fixed harness allowlist |
| Executed server methods | getblockchaininfo, getblockhash(0), getnetworkinfo, getpeerinfo, stop |
| Shutdown | stop was final server method; exit 0; `Shutdown: done` |

One additional allowed `getblockchaininfo` readiness attempt did not reach the
server method log. No wallet, mining, transaction submission, public network,
Core service, real funds or settlement was used. Private binaries/data/cookie
were excluded from the artifact; all six public members and artifact digest
were independently checked after download.

The node's `networkactive: true` and IPv4/IPv6 `reachable: true` report protocol
support flags. They do not establish connectivity: there is no external
interface/route in this fresh namespace, listen/connect/discovery/DNS/UPnP/Tor
were disabled, and actual peers/connections were zero. The pinned old release
has no server-side method ACL; the restriction is enforced by the sole trusted
harness, private cookie and otherwise empty namespace. This limitation is
explicit, not represented as a native node method whitelist.

## Evidence retention defect and correction

Run 40892627943 passed its execution step but failed public-artifact upload with
EACCES. A shell `-d` test from the caller could not traverse the root-owned 0700
directory, so ownership handoff was missed. It remains a failed run and was not
accepted as D1 evidence. The minimal correction uses `sudo test -d` before
returning ownership of **only** the public parent/evidence paths. Private
binary/data directories remain root-owned. A fresh authorized isolated run
then completed all checks and artifact retention successfully.

The temporary branch/path/exact-message execution trigger is now removed.
The workflow is dispatch-only with explicit D1 authorization input. Eleven
adversarial offline tests pass. D0 remains source-rebuild PASS; upstream prebuilt
GPG provenance remains BLOCKED. D2–D9 are not executed or qualified. No registry
capability, financial activation or Mainnet behavior changed.

Raw public evidence: `evidence/doge-d1-20261029/`. The complete further roadmap is
`../DOGECOIN_D2_D9_QUALIFICATION_ROADMAP.md`.
