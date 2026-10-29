# Offline research modules — terms, evidence and crash recovery

Status: **PASS for the listed local software tests; NOT TESTED on any chain**.
These modules are prototypes under `asset-exchange/research`, imported only by
research tests. They grant no chain capability, request no signature and have
no executor, RPC, wallet, transport or production-service dependency.

## Implementation and tests

| Module | Implemented behavior | Demonstrated boundary |
| --- | --- | --- |
| `offline-data.mjs` | Bounded canonical JSON commitments; reject non-JSON values, prototype keys, accessors, sparse arrays and unsafe numbers | Data hashing is SHA-256 via Node's standard library; this is not authentication |
| `offline-terms.mjs` | Bind all twenty directions to a caller-pinned five-profile synthetic manifest, exact network/genesis/profile digests, canonical integer amounts/reserves, refund destination commitments and bounded consent validity | Only `synthetic-offline` profiles are accepted. DOGE–XMR stays `NO_REVIEWED_ROUTE` in both directions. No address/script/consensus validator is implied |
| `offline-evidence.mjs` | Validate configured source identities, unique independence groups, network/terms/plan binding, epoch, observations, freshness and confirmations; any dissenting observation holds progression, even with a majority | Source independence and chain facts are caller assumptions. No actual peer proof, signature, block header or chain finality is verified |
| `offline-journal.mjs` | Private owned POSIX files, single-link/nonsymlink checks, bounded append-only hash chain, schema versioning, exact event allowlist, exclusive writer lock, CAS, idempotence, file/directory fsync and recovery export | A retained independent checkpoint detects rollback; hashes alone cannot detect an attacker rewriting the journal and the checkpoint together. No spend data or executable intent can be stored through the API |

Result envelopes retain `simulationOnly: true`, `qualified: false` and
`executableOperations: []`. `admissibleForExecution` and `refundExecutable` stay
false. Serialized checkpoint primitives are data, not authorization tokens.

Twenty new tests cover twenty directions, amount precision/overflow, wrong
profiles/networks, stale consent, unsupported route promotion, canonical data (including hidden/symbol array properties and accessors),
minority conflicting evidence, aliases/replay, epoch changes, stale evidence,
missing quorum, exact journal persistence, replay/conflicts/CAS, byte mutations,
checkpoint rollback, partial tails, UTF-8 and duplicate-key ambiguity, permissions,
symlinks/hardlinks, unknown/secret-bearing payloads, process restart and concurrent
writers. No test is skipped.

Actual full regression command on the worktree based on
`470926f416cf84caa4a407f219c72d6984f3a45b`, with official Node **22.23.4**:

```sh
npm test --prefix asset-exchange
```

Result: **191 tests, 191 PASS, 0 FAIL, 0 skip** (the prior 171 plus 20).
The complete output is `evidence/offline-recovery/foundation.tap`; its SHA-256,
source hashes, runtime version and scope are in the adjacent validation manifest.
Tests include real independent child processes contending for the same expected
head; exactly one append succeeds. A separate process reopens the flushed journal
after the writer process exits.

## Deliberate limits

- This is POSIX research software; Windows journal semantics are **NOT TESTED**
  and the API refuses to pretend support on Windows.
- The concurrency lock protects cooperating writers, not a malicious process
  controlling the same account. A lock left after a crash is **BLOCKED** for
  manual investigation, never stolen based on a PID guess or a timeout.
- A torn tail is preserved unchanged and append/read fail closed. There is no
  automatic truncation or synthetic success. A separate reviewed recovery tool
  and copy-of-evidence procedure would be needed to repair it.
- `fsync` success and process restart tests establish local filesystem API
  behavior, not durability under a host power loss, a lying storage device or
  concurrent backup restore. No such fault has been tested.
- The journal is an event/data prototype, not an authenticated user-consent
  store, operational outbox, contract state, exact-once financial executor or
  actual refund tool. It intentionally refuses financial effect event types.
- A 24-hour consent-validity ceiling is a bounded input/resource rule for this
  simulation. It is not a swap timelock, an availability assumption, or a refund
  guarantee. Chain-specific timeout qualification is still required.
- Synthetic profile genesis hashes are unmistakable test commitments. None is
  a substituted trusted genesis, official D0 input or production profile.
- Independent actual signature/script/transaction validation, wallet recovery,
  backend-independent on-chain claim/refund and D3–D9 executions remain
  **NOT TESTED/BLOCKED** as appropriate. No production behavior changes.

No external source code or cryptographic primitive has been imported. The only
cryptographic operation added here is SHA-256 from `node:crypto` for nonsecret
research data commitments.

Review note: schema restrictions are not secret-content detection. Callers must
supply nonsecret IDs and commitments; a hex value alone cannot be distinguished
from deliberately encoded key material. No DLP or authentication guarantee is
claimed by the research export metadata.
