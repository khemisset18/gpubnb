# DOGE D8 external software broker: native input-script control

Prepared, **not executed natively**. This increment verifies only the script
inputs of three newly broker-produced synthetic refunds with the exact D0
Dogecoin1.14.9 consensus library. It neither starts a node nor calls RPC, mines,
admits or broadcasts a transaction. No old native suite is selected.

This is an external **software fixture**, not a hardware-wallet driver, physical
display test, firmware attestation or full D8/D0–D9 qualification. Signing approval
in the fixture is a test assertion against independently pinned synthetic terms.
The synthetic height1353 is a constant, not an observed native tip. The funding
transaction is serialized fixture data, not proof of an existing confirmed UTXO.

## Frozen execution boundary

The owner must review and freeze both the broker and this harness before any
native run. The parent workflow owns the manual repository/branch route and
exact execution/harness SHA validation; this directory changes no workflow or
earlier authorization, RPC allowlist or resource budget.

```sh
bash asset-exchange/qualification/dogecoin/d8/run-consensus.sh \
  VERIFIED_D0_DIRECTORY NEW_PRIVATE_WORK_DIRECTORY \
  AUTHORIZE_D8_PRIVATE_BROKER_CONSENSUS_REGTEST \
  EXACT_EXECUTION_COMMIT EXACT_REVIEWED_HARNESS_COMMIT
```

The wrapper checks exact40-character commits, the execution checkout and unchanged
reviewed sources. It reuses `d0/verify-runtime-evidence.sh` to verify retained D0
and D1 Actions identities, provenance, signed SPDX and the existing source-rebuild
trust route. It does not rerun D0 or D1. Only then does it enter a distinct Linux
namespace containing UP loopback only, with a clean environment.

Inside that namespace, `broker_consensus.py` validates the handoff, exact archive
SHA256 and signed SPDX library member. It extracts **only**
`libdogecoinconsensus.so.0.0.0`, rechecks its SHA256 and ABI using
`native_spends.native_verifier`, and only then permits the two fixture keys to be
created. Neither `dogecoind` nor `dogecoin-cli` is extracted or executed.

## New bounded observations

- Exactly two disposable keys, roles claim/refund, from the existing OpenSSL
  fixture primitive. The parent broker never calls a signing method.
- A pinned zipapp child independently checks the request/terms/review/paired
  refund public key, then signs exactly three existing fee-step formats:
  1,000,000 /10,000,000 /100,000,000 koinu. No private key bytes enter a request,
  response or zipapp. The child accesses only the explicitly selected temporary
  refund fixture path. This is not an OS sandbox or user-key integration.
- The existing broker finalizes and verifies the three returned refunds; the
  harness independently checks the returned ladder again.
- Six native input-script observations: three exact accepted broker refunds and
  three post-signature output-value mutations expected to fail, with the signed
  input, destination script, sequence and lock preserved. No new signatures are
  made for negative controls.
- C ABI flags are exactly517: P2SH|DERSIG|CLTV, input index0, ABI version1.
  These are the existing native verifier's flags, **not all standardness flags**.
  CLTV script satisfaction does not establish transaction finality against a
  chain, UTXO value, mempool acceptance, fee policy or activation height.
- Both private fixture paths are removed in `finally`, including partial failures;
  the wrapper also removes them on exit. Unlinking is not a secure-erasure claim.

Bounds: zero nodes/RPC/generated blocks/broadcasts; two fixture keys; one signer
child; three signatures; six C ABI calls;120seconds wall time;90seconds CPU;
1GiB address space;32MiB per file. Only the public `lab/evidence` directory should
be uploaded, together with provenance verification outputs. Never upload the
temporary key directory. The report retains exact public bytes, source/package
digests, child/process/namespace receipt, native results and its checksum.

## Offline preflight

```sh
python3 -m unittest discover -s asset-exchange/qualification/dogecoin/d8 -p 'test_*.py' -v
bash -n asset-exchange/qualification/dogecoin/d8/run-consensus.sh
```

These tests mock every native library load and fixture-key generation. Their
synthetic report models establish only the refusal/evidence contract, never
native acceptance. They check authorization/namespace/provenance/archive/ABI
guard ordering, cleanup after failure, deterministic public packaging, the exact
new scope and rejection of promoted/fabricated results. Real native outcomes
remain NOT_TESTED until the separately authorized frozen run actually succeeds.
