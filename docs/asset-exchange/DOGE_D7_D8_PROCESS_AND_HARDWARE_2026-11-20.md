# DOGE D7–D8: process-crash evidence and physical test procedure

Scope: internal qualification of the existing Dogecoin1.14.9 private-Regtest
candidate, based on published commit
`ac28d513abd8084842c14de7cdc92765164bbc8a`. No native node was launched for
these software checks. No production key, device or physical power switch was
used. Physical tests below are prepared, not executed; D7/D8 as complete
qualification phases remain **BLOCKED**.

## Current software evidence — 20 November 2026

The two additive test files were reconstructed after the interrupted workspace
lost its unpushed D7/D8 commits. Their bytes match the previously recorded source
hashes exactly. The old absent logs have not been recreated or presented as
available. Both complete software suites were actually executed again on the
published candidate: **40 recovery tests PASS;16 signer tests PASS;0 failures,
0 skips**. Exact commands, hashes and fresh raw logs are retained in
`research/2026-11-20/d7-d8-process/`.

Recovery-core SHA256:
`ab6221fb209ac05316a37d9b17beb26ad45317b125dd0c1866abf3d3240a1c8b`.
Rebuilt standalone zipapp SHA256:
`690a26f739217fb19701b5dc5ee3c6abac747b28e3ebaf7014c29897806c3f73`.

| Test | Actual coverage | Result |
| --- | --- | --- |
| Bundle creation | Parent sends SIGKILL after acknowledged partial write, before/after file fsync, before/after directory fsync, before/after verified readback:7 interruptions | PASS: no receipt returned; partial bytes refused; complete bytes independently verified; exclusive retry never overwrote an interrupted target |
| Observation journal | SIGKILL at partial write, before/after file fsync, before/after rename, before/after directory fsync:7 interruptions | PASS: visible journal was the entire old or entire new value, retained bundle binding and0600 mode; restart saved a new complete observation |
| Broadcast/restart software model | SIGKILL after modeled send acknowledgement before journal, before journal rename and after rename:3 interruptions | PASS: restart retransmitted the same already-signed transaction; two sends represented one distinct transaction; no new signing key in children |
| Signature ordering | Reversed, rotated and duplicated otherwise valid signatures across fee steps:3 cases | PASS: ECDSA verification refused |
| Separate display receipt | Self-consistent rehashed destination, fee ladder, request ID and expiry changes:4 cases | PASS: independently retained original digests refused replacement before public verification |
| Verifier outage | Missing executable, permission failure, timeout and negative verification:4 cases | PASS: explicit refusal and no signing fallback |
| Undeclared profile/malformed response | Additional firmware/profile claims, empty/null/object/element-type signatures and boolean schema version:8 cases | PASS: refusal; undeclared device claims never promoted support |

The17 SIGKILL checkpoints use a parent handshake, not sleep timing. The original
ephemeral software-test signing keys are destroyed before crash children start.
The RPC ledger used for restart testing is explicitly a **software model**; it
establishes no additional native admission, consensus, confirmation or device
result. Only the intended bundle/journal file is partially written; OpenSSL's
public temporary verification files are unaffected.

The unchanged successful native cases in
[44400212431](https://github.com/khemisset18/gpubnb/actions/runs/44400212431)
were not repeated. The older15 native VM incidents in
[43111959236](https://github.com/khemisset18/gpubnb/actions/runs/43111959236)
also remain attributed to their own execution
`6307538265aef8273447891f445a28531043d1b5` and source
`19f20a368c15b5cd762c9cb76fecc3549fc3dfe1`, not silently promoted to this
changed recovery core.

## Reproduce the software delta

Use the exact candidate checkout on Linux with Python3, `/usr/bin/openssl` and
an existing writable temporary directory. These are offline tests with disposable
software-test keys; they connect to no DOGE daemon/RPC service.

```bash
mkdir -p "$PWD/.qualification-tmp"
TMPDIR="$PWD/.qualification-tmp" python3 -m unittest discover -s asset-exchange/recovery/dogecoin -p 'test_*.py' -v
TMPDIR="$PWD/.qualification-tmp" python3 -m unittest discover -s asset-exchange/wallet-agent/dogecoin -p 'test_*.py' -v
```

Normal discovery selects both additive files, including the existing Foundation
workflow. The SIGKILL/proc-fd checks are Linux-specific; they are not Windows or
macOS reboot evidence. The recovery zipapp's allowlist excludes tests, so these
additions do not change its runtime package bytes. No runtime was changed by
this D7/D8 supplement.

## Physical D7 procedure — pending execution

Use only resources named inside the already authorized private laboratory. No
physical host or power controller was supplied in this session. Do not start
another lab on an arbitrary machine to satisfy these cases.

Before execution, retain outside the disposable machine: candidate full commit
and tree; recovery runtime/zipapp SHA256; D0 archive and both attestation digests;
public handoff ZIP digest and independently retained parcel receipt; physical
host identity; OS/filesystem/storage-cache settings; hash of the boot ID. The
receipt must come from the retained producer Actions output, not solely from
the downloaded parcel. Reused public chain bytes may remain unchanged, but
replacement runtime bytes require a reviewed manifest and separate receipt.
Verify every consumer runtime hash against the chosen candidate. Any mismatch
blocks candidate attribution. Never rewrite an old manifest and present its
self-computed hash as old approval.

| Case | Fault and restart | Required result and retained evidence |
| --- | --- | --- |
| H7.1: in-place OS reboot | On one named disposable recovery host, retain a verified public package and confirmed parcel; record boot-ID hash; reboot that same OS; run the existing `recovery-resume` consumer with retained receipt and a nonexistent work path | Different boot-ID hash on the same host; original backend/keys absent; fresh D0/D1 verification; public-chain replay; `ALREADY_CONFIRMED`; zero broadcasts; daemon counters reconcile |
| H7.2: interrupted pre-lock write | On disposable storage, cut power at each acknowledged write/file-fsync/directory-fsync/readback boundary using a fault controller; restore power and inspect against the independently retained intended receipt | No receipt means no permission to fund; incomplete/missing bytes refuse; a receipt returned before the cut must still load/verify; retain controller timestamps, stdout, files and storage settings |
| H7.3: interrupted journal | Cut power before/after atomic rename and directory fsync; reboot and inspect the journal before reuse | Old/new complete observation or missing state handled by fresh chain observation; never false confirmation, wrong bundle binding or duplicate distinct financial action |
| H7.4: lost recovery machine | Remove only the named disposable recovery host; restore the public package onto another identified physical host inside the authorized laboratory | No old process/workspace/backend/key directory; correct network/genesis; exact raw refund/destination/value; no new signature; retain both physical identities and daemon counters |

Existing consumer invocation, using the frozen values above:

```bash
GITHUB_SHA="$CANDIDATE_COMMIT" bash "$PUBLIC_HANDOFF/asset-exchange/qualification/dogecoin/d6/run-multinode.sh" \
  "$VERIFIED_D0_DIRECTORY" "$NEW_NONEXISTENT_WORK_DIRECTORY" \
  AUTHORIZE_D6_PRIVATE_MULTINODE_REGTEST recovery-resume \
  "$PUBLIC_HANDOFF" "$INDEPENDENT_HANDOFF_SHA256"
```

This retains the existing D0/D1 verification, loopback-only namespace, disabled
wallets, replay-only consumer and bounded RPC/block budgets. It is a prepared
procedure, not execution evidence. H7.2/H7.3 need a controller that identifies
the actual persistence boundary; SIGKILL alone supplies no power-cut evidence.

## Physical D8 procedure — pending candidate and device

No hardware model/firmware/profile has been chosen or tested. Existing software
provides request validation, review fields, response finalization and public
signature verification. A transport, device adapter, pairing/origin mechanism
and actual device display have **no implementation/evidence here**. Adding such
a product integration exceeds this correction-only mission. Generic Dogecoin
support is not evidence for this exact Regtest legacy P2SH/CLTV profile;
unsupported combinations must remain rejected.

For each future test record: device model/serial hash; firmware/build hash and
vendor signature provenance; host adapter version/hash; exact Regtest genesis,
profile and script template; public key; request and separately trusted terms
digests. Use a new disposable test seed only on the device. Never export the
seed or include it in logs. A named operator and physical-device consent are
required before use.

| Case | Procedure | PASS condition |
| --- | --- | --- |
| H8.1: compatibility | Present a validated public request through a reviewed adapter; refuse unsupported script/network or blind-sign requirements | Exact pinned network/script accepted with supported semantics, or explicit unsupported refusal; refusal does not qualify the device |
| H8.2: display | Operator compares each `signer_review_fields` field with the actual device screen, fee step by fee step | Exact independently verified destination script/address mapping, input/refund/fee, network/domain, lock/sequence and refund role; retain image/video and operator record; omitted/unverifiable terms fail |
| H8.3: mutation | Separately change destination, amount, fee, lock, sequence, sighash, funding outpoint and network; retain original trusted receipts | Every changed request refuses; no hidden authority or normalization; original returned bytes pass response finalization, exact parsing and public signature verification |
| H8.4: disconnect/replay | Disconnect before display, during approval and during response; reconnect and retry; replay response after changed request/expiry | Explicit refusal/no response; no fallback signing or automatic broadcast; changed/expired responses refuse; identical accepted response produces only the same authorized raw transactions |
| H8.5: firmware/profile mismatch | Change firmware/profile identity independently of requested terms; repeat unsupported script/chain | Explicit refusal until that exact combination has separate evidence; no fallback profile or blind signing |

Stop on any unexpected signature acceptance, altered byte, blind-sign prompt or
mismatched display. Retain public requests, independent receipts, returned public
bytes and logs. Do not fund or broadcast to test questionable hardware behavior.

## Decision for this supplement

D7 process-crash software supplement: **PASS**. D8 additional policy-boundary
software supplement: **PASS**. D7 physical reboot/power-loss/host independence:
**NOT_TESTED**. D8 actual transport/device adapter/pairing: **NOT_IMPLEMENTED**;
device/firmware/display/disconnect: **NOT_TESTED**. Whole D7/D8: **BLOCKED**,
including earlier-phase prerequisites. No independent audit criterion is met by
these internal tests.
