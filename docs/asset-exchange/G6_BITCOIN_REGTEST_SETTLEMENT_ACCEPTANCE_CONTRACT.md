# G6 Bitcoin Regtest Settlement Acceptance Contract

Status: PRE-IMPLEMENTATION TEST CONTRACT / NO REAL FUNDS / NO MAINNET

This document defines the minimum evidence required before any Bitcoin lock/redeem/refund implementation can advance beyond regtest.

The current regtest smoke harness only proves the Bitcoin Core 31.1 toolchain, network isolation, mempool/confirmation behavior, and controlled reorg handling. It does **not** approve a settlement script.

## 1. Preconditions

Before settlement code is written:

- exact script template must be documented byte-for-byte;
- supported Bitcoin Core version profile must be pinned;
- sighash policy must be explicit;
- locktime semantics must be explicit;
- fee-bump strategy must be explicit;
- signer/PSBT compatibility must be explicit;
- recovery bundle content required before funding must be explicit;
- all values must be integer satoshis;
- no server-held wallet seed/private key is permitted.

## 2. Required script-level test vectors

For every proposed lock script, tests MUST include:

1. expected script bytes;
2. expected scriptPubKey;
3. expected address if an address representation exists;
4. expected redeem witness/script stack;
5. expected refund witness/script stack;
6. wrong-secret rejection;
7. wrong-key/signature rejection;
8. early-refund rejection;
9. wrong-network rejection;
10. mutated script rejection.

Test vectors must be deterministic and independently reproducible.

## 3. Funding transaction tests

The funding path MUST prove:

- output value equals exact agreed atomic amount;
- destination script is exactly the reviewed lock script;
- no unexpected outputs;
- change output belongs to the signer;
- fee is inside configured bounds;
- allowed sighash type only;
- locktime and sequence values are explicitly validated;
- PSBT prevout data is complete and correct;
- signer rejects unknown or mutated outputs;
- transaction passes local pre-broadcast checks.

A funding transaction MUST NOT be broadcast until the recovery/refund path is independently constructible by the party at risk.

## 4. Redeem tests

Redeem MUST be tested for:

- correct secret;
- correct key/signature;
- exact intended principal output;
- fee policy;
- mempool acceptance;
- confirmation;
- reorg back to mempool;
- rebroadcast/reconciliation after restart;
- duplicate redeem attempt rejection;
- mutated recipient rejection.

The application state MUST NOT become COMPLETED from lock confirmations alone.

## 5. Refund tests

Refund MUST be tested for:

- refund impossible before the protocol timeout;
- refund valid after the exact timeout condition;
- wallet/API/frontend completely unavailable;
- recovery bundle alone sufficient to reconstruct required public transaction material;
- refund broadcast from independent tooling;
- fee increase when the original fee is insufficient;
- crash immediately before broadcast;
- crash immediately after broadcast;
- transaction already in mempool;
- transaction already confirmed;
- refund reorged out of a block;
- conflicting spend detection.

Recovery/refund capability MUST never be disabled by Conformité/Souverain transitions or kill switches.

## 6. Fee and pinning tests

Before production qualification:

- low fee;
- high fee;
- sudden fee spike;
- ancestor/descendant policy limits;
- replacement policy interaction;
- CPFP/replacement strategy where used;
- adversarial transaction attempting to block fee bump;
- wallet unavailable during fee spike.

No claim of reliable recovery is allowed until the selected fee-bump construction survives these tests under the pinned policy profile.

## 7. Reorg matrix

At minimum force:

- 1-block reorg before principal spend;
- 1-block reorg after redeem;
- 1-block reorg after refund;
- multi-block reorg within the configured confirmation threshold;
- watcher sources disagreeing about tip/confirmation;
- transaction returning from confirmed to mempool;
- transaction becoming conflicted.

State transitions must be reversible where chain evidence is reversible.

## 8. Crash matrix

Inject process termination:

- before durable intent write;
- after durable intent write, before signing;
- after signing, before broadcast;
- during broadcast;
- after broadcast, before txid persistence;
- after txid persistence, before response;
- after confirmation observation, before state transition commit.

After restart, reconciliation must derive state from durable DB data + chain evidence. It must not create a second economic action because an HTTP response was lost.

## 9. Watcher trust tests

A single watcher MUST NOT authorize an irreversible action solely by assertion.

Tests must cover:
- stale tip;
- wrong network;
- wrong txid;
- conflicting block hash;
- impossible confirmation count;
- delayed source;
- one malicious source among multiple sources.

Disagreement must result in UNCERTAIN/CONFLICT and stop new irreversible commitments while preserving recovery.

## 10. Recovery bundle tests

Encrypted recovery bundle MUST prove:

- authenticated decryption;
- wrong-key failure;
- tag/ciphertext tamper failure;
- version mismatch failure;
- deployment mismatch visible after authenticated decrypt;
- no wallet seed/private key/spend key/mnemonic/password fields;
- bundle export before first lock;
- import using standalone recovery tooling;
- no dependency on gpu.k.p2p API availability.

## 11. Double-action safety

For one principal output:

- redeem and refund cannot both become confirmed valid spends;
- repeated commands are idempotent;
- accept/cancel race remains single-winner before settlement;
- stale policy epoch cannot start a new lock;
- mode transition cannot create a new lock;
- mode transition cannot invalidate an existing refund path.

## 12. Test environments

Required order:

1. pure deterministic unit tests;
2. Bitcoin Core regtest isolated node;
3. crash/restart regtest;
4. forced reorg regtest;
5. multi-node isolated regtest;
6. Bitcoin testnet/signet only after G6 regtest evidence is green;
7. external security review;
8. Mainnet canary only after explicit owner approval.

## 13. Stop-ship failures

Any of these is STOP-SHIP:

- user can lose both asset and recovery path under documented assumptions;
- recovery depends on gpu.k.p2p servers being online;
- private wallet key reaches server logs/storage;
- fee policy can strand refund;
- script/signature mutation is accepted;
- stale epoch can create a new lock;
- chain disagreement is treated as final truth;
- refund can be administratively disabled;
- state says COMPLETED without proven principal spends;
- same offer/trade produces more than one principal commitment.

## 14. Evidence package

Each regtest protocol revision must archive:

- Bitcoin Core version + binary hash;
- script template hash;
- protocol version;
- test vector hashes;
- CI run ID;
- source commit;
- reorg/crash test logs;
- fee-policy profile;
- recovery bundle format version;
- list of known limitations.

Passing this contract is necessary but not sufficient for production authorization.
