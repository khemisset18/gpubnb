# gpu.k.p2p — G3 Recovery and Independent Funds Recovery Specification v0

Status: G3 DRAFT / PRE-IMPLEMENTATION / NO REAL FUNDS

## 1. Purpose

This document defines the recovery architecture for gpu.k.p2p.

The goal is simple:

A user must retain a safe, deterministic path to recover funds even if:
- gpu.k.p2p frontend is unavailable;
- Asset Exchange API is unavailable;
- workers are stopped;
- Redis is deleted;
- ordinary watchers are unavailable;
- the deployment is quarantined;
- the operator has disabled new offers/trades;
- the user changes browser/device;
- the commercial service disappears.

Recovery must not depend on GPUbnb Core.

This specification complements PROTOCOL_RFC_V1.md.

## 2. Fundamental recovery invariant

If funds have been cryptographically locked and the protocol defines a valid refund/redeem path,
the user must not lose that path merely because gpu.k.p2p infrastructure is unavailable.

A feature flag, KYC state, commercial mode, frontend state, admin action, subscription state,
account suspension or API outage MUST NOT erase an already-valid chain-level recovery right.

## 3. Non-custodial recovery

gpu.k.p2p must not require possession of:
- wallet seed;
- raw private key;
- wallet password;
- hardware-wallet recovery words;
- Monero spend key;
- arbitrary wallet file

to restore protocol recovery.

Recovery material contains only the minimum protocol data required to identify, reconstruct,
verify and execute the user's valid recovery path.

Signing remains user-side.

## 4. Recovery levels

R0 — Information only
- trade identifiers;
- signed terms;
- chain/network;
- public scripts;
- public transaction IDs.

R1 — Reconstructable recovery
- R0 plus exact construction metadata sufficient to rebuild refund/redeem transaction using user's wallet.

R2 — Prepared recovery
- R1 plus fully prepared unsigned/partially signed recovery transaction where protocol permits.

R3 — Independently executable recovery
- user can perform recovery with documented offline/alternate tooling and own signing key without gpu.k.p2p API.

Production settlement must reach an approved R3 profile before Mainnet.

## 5. Recovery bundle

Canonical name:

GPUBNB-ASSET-EXCHANGE-RECOVERY-BUNDLE-V1

The bundle is a versioned portable file.

It must be:
- self-describing enough for supported recovery tooling;
- integrity protected;
- optionally/usually encrypted according to data class;
- independently exportable;
- independently verifiable;
- free of server-only secrets;
- free of wallet private keys.

## 6. Outer container

Conceptual outer structure:

RecoveryEnvelopeV1 {
  magic
  envelope_version
  protocol_id
  protocol_version
  trade_id
  deployment_id
  created_at
  encryption_profile
  kdf_profile?
  salt?
  nonce_or_stream_header?
  ciphertext
  integrity_metadata
}

Exact binary serialization must be deterministic/versioned before implementation.

## 7. Plain recovery payload

Conceptual encrypted payload:

RecoveryPayloadV1 {
  bundle_version
  trade_id
  offer_hash
  signed_terms
  party_role
  chain_profiles
  policy_versions
  settlement_protocol
  leg_a
  leg_b
  known_chain_evidence
  recovery_actions
  generated_at
  expiry_semantics
  verification_hashes
}

It must contain no private wallet key.

## 8. Per-leg recovery data

RecoveryLegV1 should include as applicable:

- canonical asset identity;
- chain/network ID;
- role;
- HTLC/redeem script bytes;
- script hash/address;
- funding transaction bytes if public/needed;
- funding txid/wtxid;
- output index;
- expected value;
- redeem pubkey;
- refund pubkey;
- secret hash;
- refund locktime/sequence semantics;
- prepared refund transaction or reconstruction template;
- prepared redeem template if safe;
- fee policy/profile;
- confirmation policy;
- expected recovery destination;
- chain profile version.

## 9. Secret material classification

The bundle may contain protocol secrets only when strictly required for that user's legitimate
recovery role.

Examples:
- HTLC preimage S may be needed by one party after valid disclosure.

Rules:
- do not include S before protocol semantics permit;
- never include wallet private key;
- never log S;
- encrypt bundle if S or other sensitive material is included;
- distinguish PUBLIC, SENSITIVE and FUND_CRITICAL fields.

## 10. No fake recovery

A "Download recovery file" button is not sufficient.

For every recovery bundle version, tests must demonstrate that:
- production frontend is unavailable;
- production API is unavailable;
- normal worker is unavailable;
- user can still verify current chain state;
- user can construct/sign/broadcast the valid recovery transaction.

If this is not proven, recovery is not R3.

## 11. Recovery tool independence

Preferred architecture includes a separate recovery tool/package that is:
- open-source;
- versioned;
- signed/reproducible where practical;
- able to operate without the main web application;
- able to read old supported bundle versions;
- able to verify chain/network before action.

Possible interfaces:
- local CLI;
- local desktop recovery utility;
- documented wallet-compatible manual procedure.

The main commercial UI is not the only recovery interface.

## 12. Recovery tool network model

The tool may:
- connect to user's own full node;
- connect to explicitly selected trusted RPC;
- use multiple approved public sources only if security model permits.

It must not:
- blindly trust an endpoint embedded in bundle;
- allow arbitrary URL fetching without SSRF/network controls;
- assume gpu.k.p2p infrastructure exists.

## 13. Recovery verification before action

Before any refund/redeem:

1. parse and authenticate bundle;
2. verify protocol/bundle version;
3. verify chain and network;
4. verify signed terms;
5. reconstruct expected lock script;
6. verify exact lock outpoint/value;
7. verify current spend status;
8. verify maturity/secret requirements;
9. verify destination belongs to expected user recovery target;
10. verify fee;
11. ask user to sign locally;
12. independently inspect resulting transaction;
13. broadcast;
14. track confirmation/reorg.

## 14. Chain identity

Recovery tool must verify chain identity using:
- configured chain ID;
- network ID;
- genesis hash or equivalent invariant;
- supported node profile.

A Bitcoin regtest bundle must never be accepted against Mainnet.

## 15. Signed terms verification

Bundle recovery cannot trust the bundle metadata alone.

It must recompute:
- canonical terms bytes;
- offer/terms hash;
- party signatures;
- protocol domains;
- expected chain script parameters.

Corrupted metadata must fail closed.

## 16. Bundle tampering

Any unauthorized change to encrypted/authenticated bundle content must be detected before parsing
sensitive actions.

No "best effort" recovery from authentication failure.

Corrupt bundle:
- stop;
- preserve file;
- show safe diagnostic;
- allow import of another backup.

## 17. Encryption strategy

Bundle encryption uses standard reviewed cryptography.

Preferred design candidates:

A. High-entropy random recovery key
- random 256-bit key;
- AEAD;
- key displayed/exported separately or protected by platform/hardware mechanism.

B. User passphrase
- Argon2id derives encryption key;
- AEAD encrypts bundle;
- per-bundle random salt;
- parameters stored in envelope;
- minimum parameter policy versioned.

Do not derive encryption directly using SHA256(password).

## 18. KDF

If passphrase-based encryption is supported:

Preferred:
Argon2id, following current reviewed guidance.

KDF profile contains:
- algorithm;
- version;
- memory cost;
- iterations/time cost;
- parallelism;
- salt length.

Parameters require benchmarks across supported clients and must resist trivial low-memory configurations.

No silent downgrade.

## 19. AEAD

Use standard authenticated encryption.

Candidate profile:
XChaCha20-Poly1305 where chosen library/platform interoperability is acceptable.

Alternative standard AEAD may be selected only after documented review.

Requirements:
- random unique nonce/header as required;
- authentication before accepting plaintext;
- associated data binds public envelope identity/version;
- no nonce reuse under same key.

Do not invent encryption.

## 20. Associated data

AEAD additional authenticated data should bind non-secret outer fields such as:
- envelope magic;
- version;
- protocol ID;
- trade ID;
- encryption profile ID.

This prevents ciphertext being transplanted into a different semantic context.

## 21. Passphrase UX

If user chooses passphrase:
- warn that forgotten passphrase can make bundle unusable;
- encourage password manager/offline storage;
- do not impose artificial complexity rules that encourage predictable patterns;
- do not transmit passphrase to server;
- derive/decrypt locally.

No password recovery backdoor.

## 22. Random recovery key UX

If using random recovery key:
- generate locally with CSPRNG;
- never log;
- never send in analytics;
- clearly separate key from encrypted bundle backup location;
- offer printable/offline representation if safe;
- require confirmation user retained it.

Do not auto-email fund-critical recovery keys.

## 23. Platform protection

Optional local convenience copies may use:
- Windows DPAPI/CNG;
- macOS Keychain/Secure Enclave where appropriate;
- Linux secret-service/keyring where appropriate.

But portable independent bundle must not depend exclusively on one OS keystore if portability is a recovery goal.

OS protection is an additional layer, not the sole recovery mechanism.

## 24. Hardware wallet compatibility

Recovery must work with supported hardware wallets without extracting seeds.

Recovery tool prepares transaction intent; device signs after displaying/verifying as much intent as device supports.

Compatibility matrix must identify limitations.

## 25. Prepared refund

For protocols requiring refund prepared before lock:

Bundle should include:
- exact prepared refund transaction/PSBT where safe;
- lock outpoint;
- redeem script;
- maturity conditions;
- expected destination;
- fee strategy metadata;
- hashes.

User should possess this bundle before corresponding lock is broadcast.

## 26. Bundle issuance timing

Critical rule:

A recovery bundle required for refund MUST be generated, validated and successfully exported before
the protocol crosses the point where user funds become dependent on it.

Workflow:

PREPARE
-> BUILD RECOVERY
-> VERIFY RECOVERY
-> USER/CLIENT CONFIRMS EXPORT
-> ONLY THEN ALLOW LOCK SIGN/BROADCAST

If export fails, no lock.

## 27. Export confirmation

Do not trust only a UI click.

Client should verify:
- bundle bytes available;
- bundle re-parses;
- authentication/decryption test succeeds locally;
- required fields present;
- hash shown/stored.

For highest-risk flows, require user acknowledgment that bundle is saved before continuing.

## 28. Multiple backups

User may keep multiple encrypted copies.

Bundle must not contain anti-copy assumptions.

Security comes from encryption/key control, not scarcity of file copies.

## 29. Recovery bundle hash

Expose a stable hash of exact bundle bytes for:
- backup comparison;
- support diagnostics;
- integrity inventory.

Hash is not a secret.

Do not confuse hash with authenticated encryption.

## 30. Recovery manifest

User-friendly manifest may show:
- trade ID;
- asset/network;
- role;
- creation date;
- refund condition;
- bundle version;
- file hash.

Do not expose fund-critical secret in plaintext manifest.

## 31. Versioning

Reader must:
- accept explicitly supported versions;
- reject unknown critical versions;
- never reinterpret v1 as v2;
- support migration only through reviewed transformation.

Old active trades pin old bundle/protocol version.

## 32. Recovery software retention

If old bundle versions remain capable of protecting live funds, corresponding recovery tooling/source
must remain available for the maximum relevant recovery lifetime.

Do not delete old recovery code immediately after release upgrade.

## 33. Offline recovery

Design target:
recovery bundle can be opened/verified on a clean machine.

Where chain data is required, allow:
- offline verification of terms/scripts;
- later online broadcast via separate machine/tooling where operationally practical.

Air-gapped signing support is desirable for high-value use.

## 34. Recovery when site disappears

Documented disaster case:
- DNS expired;
- web domain unavailable;
- operator company unreachable;
- normal API permanently gone.

User must still have:
- signed terms;
- script/outpoint data;
- recovery instructions;
- compatible recovery tool/source;
- own wallet key/device.

This is a mandatory G3 acceptance scenario.

## 35. Recovery when DB is destroyed

The user's recovery must not depend solely on server DB.

Bundle includes enough immutable public/protocol context to reconstruct action.

Server backups help operations but are not user's only recovery mechanism.

## 36. Recovery when Redis is destroyed

No effect on financial recovery truth.

Redis is never required to determine refund eligibility.

## 37. Recovery when watchers are wrong

User/recovery tool can re-query chain independently.

A watcher DB flag is not authority.

## 38. Recovery when KYC provider is down

KYC outage may block new regulated activity according to policy.

It must not make an already-valid cryptographic refund impossible.

Recovery UI/tool is outside KYC provider availability dependency.

## 39. Recovery in SOUVERAIN / CONFORMITE

Both modes provide identical cryptographic recovery safety.

Commercial/regulatory policy may affect new actions, but must not silently destroy chain-level recovery rights.

Mode switch cannot change existing signed timeout/script semantics.

## 40. Recovery after account loss

If user loses gpu.k.p2p account/session but still holds:
- wallet signing key/device;
- bundle;

the technical recovery path should remain possible where protocol permits.

Account authentication is not the cryptographic owner of locked funds.

## 41. Recovery after wallet-account change

If wallet changes its displayed account:
- recovery tool must use the key/address required by signed protocol;
- never silently substitute current wallet default account.

User must explicitly select correct signing identity.

## 42. Recovery destination

Recovery destination should be fixed/validated before lock where protocol design permits.

If destination can be changed later:
- require local strong verification;
- prevent server from unilaterally redirecting recovered funds.

No recovery transaction may use a destination supplied only by an unauthenticated webpage.

## 43. Fee spike recovery

Bundle/recovery profile must record fee policy.

Recovery tooling must support reviewed fee-bumping method where protocol supports it.

If refund cannot be fee-bumped safely:
- protocol risk must be explicit;
- production approval blocked until acceptable strategy exists.

## 44. Mempool eviction

If prepared refund is valid but not retained in mempool:
- keep exact transaction;
- rebroadcast according to privacy/safety policy;
- bump fee only using reviewed method;
- verify output remains unspent.

Mempool presence is not durable state.

## 45. Reorg during recovery

Recovery tool tracks:
- block hash;
- height;
- confirmations;
- conflicting spends.

If refund/redeem confirmation is reorged:
- return to observing/recovery state;
- do not claim terminal success prematurely.

## 46. Secret revelation recovery

If HTLC preimage becomes public:
- recovery tooling must derive that fact from expected chain spend;
- record exact source transaction;
- verify SHA256(preimage)=H.

Do not import arbitrary preimage text from chat/support.

## 47. User verification

Recovery UI prioritizes:
- exact asset;
- exact network;
- exact amount;
- exact destination;
- current chain state;
- refund/redeem reason;
- deadline/maturity;
- fee.

Technical details available through expandable advanced view.

## 48. Support boundary

Support staff may help interpret:
- bundle version;
- public file hash;
- public txid;
- public error code.

Support must never request:
- seed phrase;
- private key;
- wallet password;
- recovery encryption key;
- full decrypted sensitive bundle.

## 49. Redacted diagnostic export

Recovery tool may generate a diagnostic package containing:
- versions;
- public hashes;
- public chain evidence;
- error codes.

It must exclude:
- encryption key;
- passphrase;
- private keys;
- secret preimage unless already public and necessary;
- sensitive identity data.

## 50. Recovery logs

Local logs:
- opt-in/controlled;
- bounded;
- secret redaction.

Server logs:
- cannot be required for user recovery.

## 51. Bundle backup storage

Recommended user guidance:
- at least two encrypted copies for meaningful-value trades;
- separate physical/cloud locations;
- recovery key/passphrase not stored unprotected beside bundle.

Do not force cloud storage.

## 52. Server-side copy

An encrypted server-side bundle copy may be offered only if:
- ciphertext is end-to-end encrypted with a key unavailable to server;
- deletion/retention policy clear;
- server copy is convenience only.

Server must not be sole copy.

## 53. Recovery key escrow

Default: no operator escrow of user's recovery decryption key.

Any enterprise escrow feature would require a separate threat model and must never silently become default consumer behavior.

## 54. Bundle confidentiality vs availability

Recovery architecture balances:
- confidentiality of sensitive protocol material;
- availability during disaster.

Encryption must not create a single server-held decryption dependency.

## 55. Backward compatibility

Before removing recovery support for a bundle version:
- prove no live funds can still depend on it;
- publish migration/export process;
- preserve source/documentation as required.

## 56. Recovery test vectors

For every protocol version publish test vectors containing non-secret/regtest data:
- signed terms;
- known scripts;
- known outpoints;
- expected refund construction;
- expected hashes;
- expected parser errors.

Never use production secrets in test vectors.

## 57. Corruption tests

Test:
- flipped bit;
- truncated file;
- modified header;
- wrong trade ID AD;
- wrong nonce/header;
- wrong password;
- wrong KDF parameters;
- unknown version;
- duplicated fields;
- oversized fields.

Expected:
safe rejection.

## 58. Password/KDF tests

Test:
- correct passphrase;
- wrong passphrase;
- low-memory device;
- hostile KDF parameter file;
- maximum bounds;
- malformed salt.

Reader must cap attacker-controlled resource parameters to prevent DoS.

## 59. Parser hardening

Bundle parser:
- bounded input size;
- bounded collections;
- strict schema;
- no recursive unbounded structures;
- no arbitrary object deserialization;
- no executable content;
- no URLs automatically fetched.

Treat bundle as attacker-controlled input even if encrypted.

## 60. Recovery tool update security

Recovery tool releases:
- signed;
- checksummed;
- SBOM/provenance where applicable;
- old versions available when still needed;
- no forced online update before opening bundle.

A compromised update mechanism must not strand funds.

## 61. Independent verification

Where feasible provide:
- CLI command to inspect public metadata/hash;
- deterministic script reconstruction;
- transaction decode;
- signature verification.

Expert users should be able to verify the recovery artifact independently.

## 62. Emergency operator behavior

During incident:
- stop new locks;
- keep recovery endpoints/tools available;
- publish clear status;
- avoid changing protocol semantics;
- prioritize node/RPC access for recovery;
- do not require KYC re-verification solely to download an already-owned bundle.

## 63. Destructive disaster tests

Mandatory:

D1. Delete frontend deployment.
D2. Delete API deployment.
D3. Stop all ordinary workers.
D4. Flush Redis.
D5. Remove primary watcher.
D6. Deny Core access.
D7. Simulate operator DNS outage.
D8. Restore no server DB to recovery machine.
D9. Use only bundle + user's wallet + clean node/tool.
D10. Execute valid regtest refund.

Expected:
fund recovery succeeds according to protocol conditions.

## 64. Credential compromise tests

Assume API/admin compromised.

Attacker must not:
- decrypt user bundle without user key;
- redirect refund;
- manufacture user's signature;
- disable chain-enforced refund;
- modify already signed terms.

If server compromise can do any of these, G3 fails.

## 65. Client compromise limits

A fully compromised signing endpoint can attack user signing.

Mitigations:
- hardware wallet;
- WYSIWYS;
- clean recovery machine;
- signed recovery tool;
- independent bundle.

We do not claim protection from an attacker who fully controls the user's signing device and private keys.

Threat assumptions must be explicit.

## 66. Backup-before-lock invariant

Formal invariant:

FUNDS_LOCKED(user, trade)
=> RECOVERY_MATERIAL_VALIDATED_AND_EXPORTED(user, trade)

for any protocol where local recovery material is required for safe refund.

Implementation must enforce this transition order.

## 67. No server-only secret invariant

For any valid user refund path:

REQUIRED_RECOVERY_SECRET
must not exist only inside gpu.k.p2p server infrastructure.

If a server-only secret is required, the protocol is custodial/dependent and fails this architecture.

## 68. Recovery availability invariant

Disabling:
- new_offers
- new_accepts
- new_locks

must not imply disabling:
- redeem
- refund
- recovery export/read
- chain observation needed for recovery.

## 69. Formal G3 properties

REC-01 user recovery does not require Core availability.
REC-02 user recovery does not require Exchange API availability.
REC-03 Redis loss cannot destroy recovery.
REC-04 policy-mode change cannot invalidate signed chain recovery.
REC-05 KYC outage cannot destroy cryptographic refund path.
REC-06 bundle tampering is detected.
REC-07 server cannot decrypt protected bundle without user-controlled material.
REC-08 bundle never contains wallet private key.
REC-09 valid bundle + wallet key + chain access is sufficient for approved R3 recovery.
REC-10 recovery action cannot redirect funds without explicit valid user authorization.

## 70. Formal model extension

G2 TLA+/equivalent model must extend with:
- APIUnavailable;
- FrontendUnavailable;
- WorkerUnavailable;
- RedisLost;
- WatcherUnavailable;
- RecoveryToolAvailable;
- BundlePossessed;
- UserKeyPossessed.

Model invariant:
under stated chain/liveness assumptions, if refund becomes valid and user possesses required bundle/key,
service outage does not remove eventual refund capability.

## 71. G3 PASS requirements

G3 does NOT pass from documentation alone.

Required evidence:
- finalized bundle schema;
- crypto profile reviewed;
- reference implementation;
- independent parser;
- export-before-lock enforcement;
- destructive disaster test;
- offline/alternate recovery test;
- corruption/fuzz tests;
- regtest refund from clean machine;
- security review;
- documented user procedure.

## 72. Current decisions

Decided:
- no private keys in bundle;
- no custom cryptography;
- independent portable recovery artifact;
- export before lock when required;
- recovery must work outside normal service;
- cryptographic recovery same in CONFORMITE and SOUVERAIN;
- Core is not a recovery dependency.

Pending:
- exact binary serialization;
- exact AEAD library/profile;
- Argon2id production parameters;
- exact recovery CLI implementation language;
- exact fee-bump recovery mechanism;
- hardware-wallet matrix.

## 73. Current status

G3 recovery architecture: DRAFTED.
Recovery implementation: NOT STARTED.
Recovery crypto parameters: NOT FINAL.
Disaster tests: NOT EXECUTED.
R3 proof: NOT ACHIEVED.
Real funds: FORBIDDEN.
Mainnet: FORBIDDEN.
