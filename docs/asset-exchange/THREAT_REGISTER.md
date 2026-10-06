# GPUbnb Asset Exchange — Threat Register v0

Status: WORKING DRAFT / PRE-DEVELOPMENT / NO REAL FUNDS

## Purpose

This register turns the high-level threat model into concrete release-blocking security work.

Each entry records:
- threat ID;
- component / boundary;
- attacker or failure source;
- preconditions;
- exploit or failure path;
- impact;
- severity;
- prevention;
- detection;
- recovery;
- mandatory test;
- release gate.

Severity:
- CRITICAL = potential irreversible fund loss, key compromise, settlement safety failure, or Core blast-radius breach;
- HIGH = serious integrity, availability, privacy, or authorization failure that can materially affect trades;
- MEDIUM = bounded security or reliability impact with practical mitigations;
- LOW = defense-in-depth / hardening issue.

No CRITICAL threat may remain without a defined prevention, detection, recovery and test strategy before Mainnet.

---

## A. Isolation / blast radius

### AE-ISO-001 — Asset Exchange outage breaks GPUbnb Core
Component: deployment / service dependencies
Severity: CRITICAL
Threat source: architecture coupling, shared runtime dependency
Preconditions: Core calls Asset Exchange synchronously for required functionality
Failure path: Asset Exchange outage -> Core request path blocks/fails
Impact: rental/mining/machines/workspaces/accounts unavailable
Prevention:
- no mandatory runtime dependency from Core to Asset Exchange;
- independent deployables;
- optional-only identity bridge;
- failure-open navigation integration where safe.
Detection:
- synthetic Core tests with Asset Exchange fully disabled.
Recovery:
- Core must require no recovery action from Asset Exchange outage.
Mandatory test:
- delete/disable Asset Exchange services and verify all Core capabilities continue.
Gate: G0

### AE-ISO-002 — Shared database creates financial/core blast radius
Component: PostgreSQL
Severity: CRITICAL
Threat source: migration bug, SQL injection, destructive operator error
Preconditions: Asset Exchange and Core share DB/roles/schema privileges
Failure path: Exchange migration/query modifies or exhausts Core DB
Impact: Core outage/data corruption; cross-domain compromise
Prevention:
- separate database instance or hard isolation with separately administered cluster as transitional only;
- distinct credentials, roles, migrations and backups;
- no Exchange role access to Core DB.
Detection:
- credential/ACL tests; infrastructure policy checks.
Recovery:
- independent backup/restore domains.
Mandatory test:
- Exchange DB credentials must fail against Core DB.
Gate: G0

### AE-ISO-003 — Shared Redis causes cross-system corruption or outage
Component: Redis/cache
Severity: HIGH
Threat source: key collision, eviction, compromise, resource exhaustion
Preconditions: shared Redis or shared privileged credentials
Failure path: Exchange workload evicts/overwrites Core state
Impact: degraded or incorrect Core behavior
Prevention:
- dedicated Redis/cache;
- separate auth and network policy;
- Redis never financial source of truth.
Detection:
- tenancy/credential checks; load isolation test.
Recovery:
- Exchange cache rebuildable from durable state.
Mandatory test:
- stop/flush Exchange Redis and verify Core unaffected.
Gate: G0

### AE-ISO-004 — Shared secrets expose Core after Exchange compromise
Component: secrets / IAM
Severity: CRITICAL
Threat source: application compromise, CI leak, operator mistake
Preconditions: Exchange service can read Core secrets
Failure path: compromise Exchange -> extract Core production credentials
Impact: compromise of rental/mining/Core infrastructure
Prevention:
- separate secret namespaces and service identities;
- least privilege;
- no wildcard secret access.
Detection:
- IAM policy audit; canary secret access tests.
Recovery:
- independent credential rotation.
Mandatory test:
- Exchange identity denied access to every Core secret.
Gate: G0

### AE-ISO-005 — Shared network allows lateral movement into Core
Component: network architecture
Severity: CRITICAL
Threat source: compromised Exchange service
Preconditions: flat network or unrestricted east-west connectivity
Failure path: compromised Exchange host probes Core DB/Redis/admin services
Impact: Core compromise
Prevention:
- explicit network segmentation;
- deny-by-default east-west ACLs;
- service-specific allowlists.
Detection:
- network flow logs; denied-connection alerts.
Recovery:
- isolate Exchange segment without impacting Core.
Mandatory test:
- penetration test from Exchange workload toward Core private services must fail.
Gate: G0

---

## B. Identity / authentication / authorization

### AE-ID-001 — Replayed Core identity ticket
Component: optional SSO bridge
Severity: HIGH
Threat source: attacker stealing a short-lived ticket
Preconditions: ticket reusable; no nonce/jti consumption where needed
Failure path: replay ticket -> create second valid Exchange session
Impact: account takeover window
Prevention:
- short expiry;
- issuer/audience binding;
- jti/nonce;
- TLS;
- replay policy.
Detection:
- duplicate jti telemetry.
Recovery:
- revoke Exchange session independently.
Mandatory test:
- replay identical ticket and verify rejection according to policy.
Gate: G1/G2

### AE-ID-002 — Wrong-audience / cross-service token confusion
Component: SSO bridge
Severity: CRITICAL
Threat source: token substitution
Preconditions: verifier accepts generic Core token
Failure path: token issued for another service accepted by Exchange
Impact: unauthorized access
Prevention:
- strict audience + issuer + version validation;
- dedicated signing context/key where appropriate.
Detection:
- auth logs for audience mismatch.
Recovery:
- key rotation/session revocation.
Mandatory test:
- tokens for Core API or other services must be rejected.
Gate: G1/G2

### AE-ID-003 — BOLA / IDOR on offers or trades
Component: API
Severity: HIGH
Threat source: authenticated malicious user
Preconditions: object access checked only by ID
Failure path: attacker changes trade/offer ID
Impact: disclosure or unauthorized mutation
Prevention:
- per-object authorization on every request;
- opaque identifiers are not authorization.
Detection:
- access-denied telemetry and anomaly detection.
Recovery:
- revoke session; audit event history.
Mandatory test:
- cross-account access matrix for every endpoint.
Gate: G1/G5

### AE-ID-004 — Admin session theft enables critical reconfiguration
Component: admin plane
Severity: CRITICAL
Threat source: phishing, malware, session theft
Preconditions: weak admin authentication or reusable session
Failure path: attacker changes mode/RPC/limits/contracts/risk status
Impact: systemic fund loss
Prevention:
- strong reauthentication;
- WebAuthn/passkey/hardware-key preference;
- short-lived privileged sessions;
- WYSIWYS confirmation challenge.
Detection:
- high-signal alerts for privileged changes.
Recovery:
- emergency revoke; configuration rollback where safe; quarantine.
Mandatory test:
- privileged action fails without fresh strong auth.
Gate: G1/G5

---

## C. Offer / trade integrity

### AE-TRD-001 — Double fill
Component: offer acceptance / DB
Severity: CRITICAL
Threat source: race condition
Preconditions: multiple takers accept concurrently
Failure path: check-then-write without atomic serialization
Impact: one maker obligation consumed multiple times
Prevention:
- PostgreSQL transaction;
- row/constraint-based concurrency control;
- whole-fill single-consumption invariant.
Detection:
- uniqueness violations and invariant monitoring.
Recovery:
- must prevent before lock; if detected pre-lock abort all but winner.
Mandatory test:
- concurrent acceptance stress test with multiple takers.
Gate: G2/G4/G5

### AE-TRD-002 — Accept/cancel race
Component: offer state machine
Severity: CRITICAL
Threat source: concurrent legitimate operations
Preconditions: maker cancels while taker accepts
Failure path: inconsistent non-transactional state
Impact: settlement on an offer maker believed cancelled
Prevention:
- one atomic DB decision;
- signed, versioned state transition semantics.
Detection:
- event-order invariant checks.
Recovery:
- no fund lock until unique terminal decision.
Mandatory test:
- high-concurrency accept/cancel fuzz test.
Gate: G2/G4/G5

### AE-TRD-003 — Signed terms mutate after authorization
Component: canonical terms
Severity: CRITICAL
Threat source: server bug or malicious server
Preconditions: mutable fields not covered by signature
Failure path: destination/amount/network/policy modified after signing
Impact: theft or wrong-chain transfer
Prevention:
- immutable canonical signed payload;
- domain separation;
- hash referenced by all later steps.
Detection:
- hash mismatch.
Recovery:
- hard-stop before fund commitment.
Mandatory test:
- mutate every field after signing; all changes rejected.
Gate: G2/G4

### AE-TRD-004 — Replay of offer/accept/cancel/settlement message
Component: protocol messaging
Severity: HIGH/CRITICAL depending on message
Threat source: network attacker or malicious party
Preconditions: no nonce/expiry/domain/state consumption
Failure path: old message reused in another trade/network/state
Impact: unauthorized operation
Prevention:
- nonce;
- expiry;
- trade ID;
- network ID;
- domain separation;
- protocol version;
- consumed-state tracking.
Detection:
- replay counters.
Recovery:
- no irreversible action; reject duplicate.
Mandatory test:
- cross-domain and cross-trade replay corpus.
Gate: G2

### AE-TRD-005 — Asset symbol spoofing / wrong asset identity
Component: asset registry/UI
Severity: CRITICAL
Threat source: malicious asset/token metadata
Preconditions: symbol/logo used as identity
Failure path: fake USDT or similarly named token substituted
Impact: user exchanges for worthless/malicious asset
Prevention:
- canonical chain+network+contract/asset ID+token ID;
- trusted registry presentation;
- confusable-name warnings.
Detection:
- registry mismatch.
Recovery:
- block pre-settlement.
Mandatory test:
- duplicate symbols and lookalike assets.
Gate: G2/G5

### AE-TRD-006 — Floating-point amount corruption
Component: amount handling
Severity: CRITICAL
Threat source: implementation error
Preconditions: float/JS Number used for precise amounts
Failure path: rounding/overflow/precision loss
Impact: wrong transfer amount
Prevention:
- integer atomic units only;
- bounded big-integer parsing.
Detection:
- serialization and range validation.
Recovery:
- reject malformed amount before signing.
Mandatory test:
- boundary/property tests across decimal conversions.
Gate: G2/G5

---

## D. Settlement / cryptographic protocol

### AE-SET-001 — Fake “locked” state without cryptographic lock
Component: settlement
Severity: CRITICAL
Threat source: naive implementation
Preconditions: frontend/server status substitutes for on-chain commitment
Failure path: participant double-spends elsewhere
Impact: counterparty loses funds
Prevention:
- protocol-specific cryptographic commitment;
- on-chain verification.
Detection:
- watcher verifies actual spend constraints.
Recovery:
- do not proceed with counter-lock absent proof.
Mandatory test:
- attempt external spend after claimed lock.
Gate: G2/G6

### AE-SET-002 — Incorrect timelock ordering
Component: atomic-swap protocol
Severity: CRITICAL
Threat source: protocol design error
Preconditions: timeout windows improperly sized
Failure path: one side loses recovery window
Impact: irreversible fund loss
Prevention:
- chain-specific timelock model;
- asymmetric safety margins;
- formal analysis.
Detection:
- runtime timeout invariant checks.
Recovery:
- protocol-specific refund path.
Mandatory test:
- adversarial delay and offline-wallet simulations.
Gate: G2/G3/G4/G6

### AE-SET-003 — Crash after broadcast before persistence
Component: worker/orchestration
Severity: CRITICAL
Threat source: process/power/database failure
Preconditions: transaction accepted but state not durably recorded
Failure path: retry constructs/broadcasts another dangerous transaction
Impact: double spend attempt, fee loss, broken state, potential fund loss
Prevention:
- idempotency;
- deterministic correlation;
- durable intent/event strategy;
- chain reconciliation.
Detection:
- startup/retry reconciliation.
Recovery:
- discover prior tx and resume from observed chain state.
Mandatory test:
- kill process at every point around broadcast.
Gate: G3/G6

### AE-SET-004 — Duplicate worker execution
Component: worker queue
Severity: CRITICAL
Threat source: at-least-once delivery
Preconditions: operation assumed exactly once
Failure path: same lock/redeem/refund action executed twice
Impact: conflicting transactions / corruption
Prevention:
- idempotency key;
- expected state;
- unique operation records.
Detection:
- duplicate operation telemetry.
Recovery:
- reconcile to canonical chain state.
Mandatory test:
- repeated/out-of-order delivery.
Gate: G2/G6

### AE-SET-005 — Refund path disabled by feature flag or quarantine
Component: policy / kill switches
Severity: CRITICAL
Threat source: configuration
Preconditions: coarse “asset disabled” switch gates all methods
Failure path: incident disables chain while users need refund
Impact: stranded funds
Prevention:
- separate newOffers/newTrades/settlement/redeem/refund/recovery capabilities;
- recovery rights override new-risk controls.
Detection:
- invariant monitor.
Recovery:
- dedicated recovery service/path.
Mandatory test:
- disable asset/mode/API while active trade requires refund.
Gate: G3/G4/G5

### AE-SET-006 — One RPC causes irreversible wrong decision
Component: watchers
Severity: CRITICAL
Threat source: malicious/stale RPC
Preconditions: single source treated as truth
Failure path: false confirmation/height/tx status
Impact: premature counter-lock/redeem decision
Prevention:
- independent sources where feasible;
- confidence policy;
- fail closed for new locks.
Detection:
- source disagreement alerts.
Recovery:
- pause new commitments; continue safe recovery.
Mandatory test:
- malicious RPC fault injection.
Gate: G1/G6/G7

### AE-SET-007 — Reorg not represented in state machine
Component: chain watcher/state machine
Severity: CRITICAL
Threat source: normal blockchain behavior
Preconditions: confirmed treated as irreversible too early
Failure path: lock confirmation disappears
Impact: unsafe counterparty action
Prevention:
- explicit REORGED path;
- chain/risk/amount confirmation policy.
Detection:
- continuous canonical-chain tracking.
Recovery:
- roll state safely before dependent irreversible action.
Mandatory test:
- 1-block, 2-block and deeper practical reorgs.
Gate: G2/G6

### AE-SET-008 — Fee spike makes refund non-relayable
Component: fee policy
Severity: CRITICAL
Threat source: congestion / policy change
Preconditions: refund fee fixed or insufficient
Failure path: refund exists cryptographically but cannot propagate
Impact: practical fund lock/loss
Prevention:
- fee margin;
- fee-bump strategy where chain permits;
- safety bounds;
- chain-specific mempool policy.
Detection:
- fee/mempool monitoring.
Recovery:
- CPFP/RBF/alternative strategy where valid.
Mandatory test:
- extreme-fee and congestion scenarios.
Gate: G2/G6

---

## E. Wallet / signing layer

### AE-WAL-001 — Server receives seed/private key
Component: wallet integration
Severity: CRITICAL
Threat source: bad architecture, logging, support tooling
Preconditions: server API accepts or captures secrets
Failure path: secret transmitted/stored
Impact: full wallet compromise
Prevention:
- no such API/schema/method exists;
- client-side signing only.
Detection:
- secret scanning / DLP-like patterns / code review.
Recovery:
- cannot reliably recover compromised secret; incident requires user wallet migration.
Mandatory test:
- API contract inspection and negative tests.
Gate: permanent blocker

### AE-WAL-002 — Malicious/wrong browser wallet provider
Component: browser-wallet boundary
Severity: HIGH
Threat source: extension compromise or provider injection
Preconditions: client trusts first injected provider
Failure path: signs with wrong account/chain or altered transaction
Impact: loss or misbinding
Prevention:
- explicit provider/account/chain confirmation;
- re-read state immediately before signing;
- WYSIWYS payload display.
Detection:
- account/chain mismatch.
Recovery:
- abort before broadcast.
Mandatory test:
- provider switches account/network mid-flow.
Gate: G1/G5

### AE-WAL-003 — Local wallet agent remote abuse / DNS rebinding
Component: localhost agent
Severity: CRITICAL
Threat source: malicious website/local process
Preconditions: unauthenticated localhost API or weak origin binding
Failure path: hostile page invokes signing method
Impact: unauthorized signatures/transactions
Prevention:
- 127.0.0.1 only;
- authenticated pairing;
- origin binding;
- capability-scoped methods;
- no permissive CORS;
- anti-DNS-rebinding design.
Detection:
- rejected-origin logging.
Recovery:
- revoke pairing; rotate local credentials.
Mandatory test:
- malicious-origin and DNS-rebinding tests.
Gate: G1/G6

### AE-WAL-004 — Wallet agent updater compromise
Component: desktop/local agent supply chain
Severity: CRITICAL
Threat source: mirror/CDN/CI compromise
Preconditions: “download latest and execute”
Failure path: malicious binary update
Impact: private-key theft from local environment
Prevention:
- signed metadata/artifacts;
- provenance;
- anti-rollback/freeze;
- version pin/policy.
Detection:
- signature/provenance verification failures.
Recovery:
- block update, revoke release key if compromised.
Mandatory test:
- tampered, rollback and mix-and-match package cases.
Gate: G8

---

## F. Chain/token-specific risk

### AE-CHN-001 — Treating forks as protocol-equivalent
Component: UTXO adapters
Severity: CRITICAL
Threat source: incorrect abstraction
Preconditions: BTC/DOGE/LTC/BCH assumed identical
Failure path: script/mempool/locktime policy difference breaks swap
Impact: non-relayable/refund failure
Prevention:
- separate Consensus/Mempool/Fee/Timelock/Reorg profiles;
- chain-specific vectors.
Detection:
- adapter capability checks.
Recovery:
- quarantine incompatible adapter.
Mandatory test:
- node-level tests per chain.
Gate: G2/G6

### AE-CHN-002 — EVM token has dangerous behavior
Component: token adapter
Severity: CRITICAL
Threat source: malicious/upgradeable token
Preconditions: token trusted only by ERC-20 shape
Failure path: fee-on-transfer, blacklist, pause, proxy upgrade, callback, rebase
Impact: incorrect lock/redeem accounting or frozen funds
Prevention:
- per-token risk inspection;
- allowlist/risk registry;
- pre-trade revalidation;
- minimal settlement contract.
Detection:
- bytecode/proxy/admin change monitoring where practical.
Recovery:
- block new trades, preserve recovery paths.
Mandatory test:
- adversarial token corpus.
Gate: G1/G6

### AE-CHN-003 — Solana Token-2022 extension changes semantics
Component: Solana adapter
Severity: CRITICAL
Threat source: token extension configuration
Preconditions: mint assumed standard SPL behavior
Failure path: TransferHook/fee/delegate/pause/etc. affects transfer
Impact: stuck or redirected settlement
Prevention:
- fetch mint/extensions/authorities before trade;
- simulate;
- explicit supported-extension policy.
Detection:
- state change revalidation.
Recovery:
- disable new settlement for changed mint.
Mandatory test:
- supported/unsupported extension matrix.
Gate: future chain gate

### AE-CHN-004 — XMR cryptography implemented from intuition
Component: Monero swap protocol
Severity: CRITICAL
Threat source: cryptographic design error
Preconditions: bespoke adaptor/DLEQ construction without expert review
Failure path: key leakage or broken atomicity
Impact: fund/key compromise
Prevention:
- derive from public research/standards;
- own specification;
- independent cryptographic review;
- license review before code reuse.
Detection:
- expert review/test vectors.
Recovery:
- no Mainnet until proven.
Mandatory test:
- cryptographic vectors + adversarial review.
Gate: G2/G8

### AE-CHN-005 — Chain incident not quarantined quickly
Component: asset risk registry
Severity: HIGH/CRITICAL
Threat source: zero-day chain/token incident
Preconditions: no granular status controls
Failure path: vulnerable asset continues accepting new locks
Impact: avoidable fund exposure
Prevention:
- NORMAL/WATCH/RESTRICTED/QUARANTINE;
- separate newTrade vs refund controls.
Detection:
- incident monitoring.
Recovery:
- immediate new-trade stop while recovery remains enabled.
Mandatory test:
- simulated chain quarantine during active trade.
Gate: G5/G9

---

## G. API / frontend / realtime

### AE-APP-001 — XSS modifies displayed destination/terms
Component: frontend
Severity: CRITICAL
Threat source: malicious metadata or injection
Preconditions: unsanitized content or weak CSP
Failure path: script alters address/transaction UI
Impact: user signs attacker-controlled destination
Prevention:
- strict CSP;
- no arbitrary HTML/SVG;
- sanitize metadata;
- WYSIWYS signing independent of DOM display where possible.
Detection:
- CSP reports; security tests.
Recovery:
- revoke compromised release; incident notice.
Mandatory test:
- XSS corpus including token metadata.
Gate: G1/G5

### AE-APP-002 — Clipboard hijacking
Component: frontend/user workstation
Severity: HIGH
Threat source: malware/site script
Preconditions: user pastes address without verification
Failure path: address changed
Impact: wrong destination
Prevention:
- checksum/network validation;
- show full/segmented address before sign;
- signed terms.
Detection:
- mismatch between intended terms and transaction.
Recovery:
- abort before signing.
Mandatory test:
- changed clipboard value after review.
Gate: G5

### AE-APP-003 — Cross-Site WebSocket Hijacking
Component: trade room
Severity: HIGH
Threat source: malicious website
Preconditions: cookie-authenticated WSS without Origin enforcement
Failure path: attacker opens authenticated socket cross-site
Impact: data leak / action abuse
Prevention:
- Origin validation;
- explicit auth;
- session expiry;
- message/rate limits.
Detection:
- rejected origins.
Recovery:
- revoke session.
Mandatory test:
- hostile-origin WebSocket test.
Gate: G1/G5

### AE-APP-004 — SSRF through configurable RPC URL
Component: admin / chain adapters
Severity: CRITICAL
Threat source: malicious admin session or misconfiguration
Preconditions: server fetches arbitrary URL
Failure path: RPC URL points to cloud metadata, localhost, Redis, Postgres, admin service
Impact: credential theft / internal compromise
Prevention:
- network-level egress isolation;
- URL parser hardening;
- DNS/IP re-resolution policy;
- block private/link-local/metadata ranges unless explicitly required in isolated connector.
Detection:
- egress logs.
Recovery:
- rotate exposed credentials; isolate connector.
Mandatory test:
- SSRF bypass corpus incl. DNS rebinding/IPv6/encoded forms.
Gate: G1/G5

### AE-APP-005 — Resource exhaustion / business-flow abuse
Component: API
Severity: HIGH
Threat source: bot/attacker
Preconditions: expensive endpoints unbounded
Failure path: offer spam, watcher fanout, signature verification or RPC amplification
Impact: outage/cost spike
Prevention:
- quotas;
- rate limits;
- bounded payloads;
- queues/backpressure;
- per-identity limits.
Detection:
- saturation/abuse metrics.
Recovery:
- shed load without disabling refunds.
Mandatory test:
- load/abuse scenarios prioritizing recovery traffic.
Gate: G5/G7

---

## H. Data / privacy / logging

### AE-DAT-001 — Sensitive secrets logged
Component: logs/telemetry
Severity: CRITICAL
Threat source: debug/error logging
Preconditions: raw request or wallet material logged
Failure path: operator/log platform exposes secret
Impact: account/wallet compromise
Prevention:
- structured allowlist logging;
- secret redaction;
- no raw bodies for sensitive endpoints.
Detection:
- automated secret scanning of logs.
Recovery:
- rotate credentials; user incident response if wallet secret exposed.
Mandatory test:
- inject synthetic secrets and verify absence.
Gate: G1/G5

### AE-DAT-002 — Identity/address/history correlation creates privacy breach
Component: data model
Severity: HIGH
Threat source: overcollection or breach
Preconditions: unified identity+IP+wallet+trade table
Failure path: dataset exfiltration
Impact: deanonymization and sensitive financial profiling
Prevention:
- minimization;
- separation;
- retention limits;
- access control.
Detection:
- data-access audit.
Recovery:
- breach response; deletion where policy allows.
Mandatory test:
- privacy data-flow review.
Gate: G1

### AE-DAT-003 — Recovery bundle leaks swap secret
Component: recovery bundle
Severity: CRITICAL
Threat source: storage compromise / weak encryption
Preconditions: excessive plaintext secret material
Failure path: attacker recovers redeem capability
Impact: fund theft
Prevention:
- minimal secret material;
- authenticated encryption;
- reviewed key-derivation/custody model.
Detection:
- integrity/authentication failure logging.
Recovery:
- protocol-specific emergency action if exposure suspected.
Mandatory test:
- tamper, wrong-key, truncation and exfiltration review.
Gate: G3

---

## I. Supply chain / build / release

### AE-SC-001 — Malicious dependency
Component: npm/crates/other dependencies
Severity: CRITICAL
Threat source: package takeover
Preconditions: unreviewed/updatable dependency executes in build/runtime
Failure path: credential theft or transaction manipulation
Impact: systemic compromise
Prevention:
- minimal dependencies;
- lockfiles;
- provenance/integrity verification;
- dependency review;
- SBOM.
Detection:
- dependency scanning and diff review.
Recovery:
- revoke affected release; rebuild from trusted source.
Mandatory test:
- reproducibility/provenance review.
Gate: G8

### AE-SC-002 — Compromised CI workflow or third-party Action
Component: CI
Severity: CRITICAL
Threat source: Action compromise / PR injection
Preconditions: broad permissions/secrets exposed
Failure path: CI exfiltrates signing/deploy secrets
Impact: malicious production artifact
Prevention:
- minimal GITHUB_TOKEN permissions;
- pinned actions;
- protected environments;
- no secrets in untrusted PR execution.
Detection:
- workflow audit.
Recovery:
- rotate credentials and signing keys.
Mandatory test:
- untrusted PR cannot access deployment secrets.
Gate: G1/G8

### AE-SC-003 — Artifact substitution / rollback
Component: release/update
Severity: CRITICAL
Threat source: compromised distribution channel
Preconditions: users trust filename/version only
Failure path: old or malicious artifact served
Impact: wallet-agent/application compromise
Prevention:
- signed artifacts;
- hashes;
- provenance;
- anti-rollback metadata.
Detection:
- verification failure.
Recovery:
- revoke release and rotate release trust root if needed.
Mandatory test:
- substitution and rollback drills.
Gate: G8

### AE-SC-004 — License incompatibility contaminates commercial product
Component: legal/supply chain
Severity: HIGH
Threat source: inappropriate code reuse
Preconditions: GPL/AGPL/custom licensed code incorporated without approval
Failure path: redistribution obligations conflict with commercial plan
Impact: legal/release blocker
Prevention:
- LICENSE_MATRIX.md;
- approval before incorporation;
- reference-only research when necessary.
Detection:
- license scanner + manual review.
Recovery:
- replace/reimplement clean-room style as appropriate.
Mandatory test:
- dependency/license review before release.
Gate: permanent commercial blocker

---

## J. Administration / policy / operations

### AE-OPS-001 — Mode transition TOCTOU
Component: mode engine
Severity: CRITICAL
Threat source: stale worker / concurrent request
Preconditions: no epoch/fencing
Failure path: request authorized under old policy executes after mode switch
Impact: unauthorized new trade/lock
Prevention:
- monotonic mode epoch on every critical operation;
- TRANSITION state.
Detection:
- stale-epoch rejection metrics.
Recovery:
- abort new action; preserve active-trade recovery.
Mandatory test:
- hold request across mode transition and attempt execution.
Gate: G2/G4/G5

### AE-OPS-002 — Kill switch strands active trade
Component: operations
Severity: CRITICAL
Threat source: incident response error
Preconditions: coarse global disable
Failure path: disable settlement also disables refund/redeem
Impact: stranded funds
Prevention:
- granular capabilities;
- recovery operations highest availability priority.
Detection:
- invariant check.
Recovery:
- independent recovery endpoint/service.
Mandatory test:
- emergency-disable all new activity during each state-machine stage.
Gate: G3/G4/G9

### AE-OPS-003 — Misconfigured RPC/contract/risk setting
Component: admin plane
Severity: CRITICAL
Threat source: operator error or compromise
Preconditions: one-click silent configuration change
Failure path: wrong contract/network/node accepted
Impact: wrong-chain settlement or false observations
Prevention:
- staged config;
- validation;
- WYSIWYS;
- config hash;
- two-person approval for selected critical changes if operational model supports it.
Detection:
- immutable audit trail + change alerts.
Recovery:
- quarantine; revert config for new operations only.
Mandatory test:
- invalid/mutated challenge cannot be approved.
Gate: G1/G5

### AE-OPS-004 — Recovery unavailable during primary outage
Component: resilience
Severity: CRITICAL
Threat source: correlated failure
Preconditions: refund tool depends on same failed API/domain
Failure path: production outage prevents users recovering
Impact: locked funds
Prevention:
- independent recovery design/tooling;
- recovery bundle;
- documented manual procedure.
Detection:
- disaster drills.
Recovery:
- alternate documented recovery path.
Mandatory test:
- simulate gpubnb.com/API/workers unavailable.
Gate: G3/G7/G9

---

## K. P2P discovery / network threats

### AE-P2P-001 — Sybil peers dominate discovery
Component: libp2p discovery / Gossipsub
Severity: HIGH
Threat source: attacker creating many Peer IDs
Preconditions: peer count or IP count treated as trust
Failure path: attacker floods mesh/index with attacker-controlled identities
Impact: degraded availability, stale offers, biased discovery, censorship pressure
Prevention:
- economic validity comes only from signatures;
- peer score is advisory, never settlement authority;
- per-peer and per-prefix connection/message limits;
- diverse bootstrap/peer sources;
- no single-peer quorum for economic state.
Detection:
- Peer-ID churn metrics;
- mesh diversity metrics;
- invalid/replayed offer ratios;
- abnormal concentration by IP/prefix/ASN where available.
Recovery:
- prune/graylist abusive peers;
- switch bootstrap sources;
- fall back to centralized/federated discovery without affecting settlement/recovery.
Mandatory test:
- large Sybil swarm cannot forge offer validity, reopen consumed offers, or disable recovery.
Gate: future P2P discovery gate

### AE-P2P-002 — Eclipse attack hides cancellations or market state
Component: peer selection / bootstrap
Severity: HIGH
Threat source: coordinated malicious peers/bootstrap nodes
Preconditions: victim peer view dominated by attacker
Failure path: victim sees stale open offers or attacker-selected subset of market
Impact: wasted acceptance attempts, censorship, privacy loss, stale state
Prevention:
- multiple independent bootstrap sources;
- peer diversity;
- signed cancellation tombstones;
- authoritative acceptance race remains outside gossip in V1;
- optional centralized/federated cross-check during hybrid rollout.
Detection:
- peer-source concentration;
- divergent discovery views;
- cancellation propagation delay metrics.
Recovery:
- reconnect through independent sources;
- refresh offer state through authoritative API before acceptance;
- retain refund/recovery independent of discovery.
Mandatory test:
- partition/eclipsed client cannot finalize acceptance from stale gossip alone.
Gate: future P2P discovery gate

### AE-P2P-003 — Stale offer replay after signed cancellation
Component: P2P offer cache / gossip
Severity: HIGH
Threat source: malicious peer replay
Preconditions: cancellation tombstones expire too early or offer replay not correlated
Failure path: cancelled signed offer is re-announced as apparently open
Impact: repeated acceptance attempts; inconsistent UX; potential race pressure
Prevention:
- signed cancellation tombstones;
- offerHash binding;
- bounded replay cache;
- cancellation retention exceeding offer lifetime;
- authoritative DB check before acceptance.
Detection:
- replay counters;
- tombstone-hit telemetry.
Recovery:
- suppress stale offer locally;
- propagate valid cancellation;
- do not create new financial state.
Mandatory test:
- replay cancelled offer after partition/reconnect and verify it never becomes accept-authoritative.
Gate: G2 / future P2P discovery gate

### AE-P2P-004 — Message flood exhausts CPU via signature verification
Component: Gossipsub validation / offer fetch
Severity: HIGH
Threat source: remote attacker
Preconditions: expensive crypto verification occurs before cheap bounds
Failure path: attacker sends high-rate malformed/oversized signed-message candidates
Impact: node CPU/memory exhaustion; discovery outage
Prevention:
- strict byte-size limits before parse;
- structural/schema validation before crypto;
- per-peer/topic rate limits;
- verification concurrency budget;
- duplicate suppression before signature verification;
- backoff/graylist.
Detection:
- verification queue depth;
- invalid-message rate;
- CPU budget alarms.
Recovery:
- shed low-priority peers/topics;
- temporary peer bans;
- centralized/federated fallback.
Mandatory test:
- malformed flood cannot starve refund/recovery services.
Gate: G1 / future P2P discovery gate

### AE-P2P-005 — Relay or bootstrap becomes hidden authority
Component: Circuit Relay v2 / bootstrap
Severity: CRITICAL
Threat source: architecture error or malicious infrastructure operator
Preconditions: client depends on relay/bootstrap for economic truth or recovery
Failure path: relay/bootstrap blocks, rewrites, or withholds required settlement control messages
Impact: censorship or stranded funds
Prevention:
- relays/bootstraps carry connectivity/discovery only;
- end-to-end signatures;
- no recovery secret at relay;
- no authoritative trade state at bootstrap;
- settlement/recovery paths independent.
Detection:
- relay availability and path-diversity monitoring.
Recovery:
- alternate relays/bootstrap;
- direct connection where possible;
- recovery remains functional with P2P entirely offline.
Mandatory test:
- remove all relays/bootstrap nodes during active locked trade; refund/recovery still works.
Gate: G3 / future P2P discovery gate

### AE-P2P-006 — DHT poisoning or unbounded record retention
Component: Kademlia DHT / provider records
Severity: MEDIUM/HIGH
Threat source: malicious peers
Preconditions: DHT records treated as truth or lack TTL/size/signature bounds
Failure path: attacker injects fake endpoints, stale offers, or resource-amplifying records
Impact: discovery poisoning, SSRF-like fetches, resource exhaustion
Prevention:
- DHT stores only discovery/index hints;
- signed bounded records;
- strict TTL;
- canonical offerHash references;
- endpoint allow/deny validation;
- never store KYC/recovery material.
Detection:
- invalid-record counters;
- conflicting-provider metrics.
Recovery:
- discard unverified records;
- alternate discovery source.
Mandatory test:
- poisoned DHT cannot create valid offer, cancel, settlement state, or internal-network fetch.
Gate: future P2P discovery gate

### AE-P2P-007 — P2P metadata deanonymizes trader activity
Component: peer identity / topics / relay paths
Severity: HIGH
Threat source: passive observer, relay, malicious peer
Preconditions: long-lived Peer IDs and fine-grained topic subscriptions correlate activity
Failure path: timing/topic/IP data linked to market interests or wallet behavior
Impact: privacy loss, profiling, compliance leakage
Prevention:
- no KYC data on P2P network;
- coarse topic partitioning;
- no wallet address in topic names;
- document that relay is not anonymity;
- minimize long-lived correlation identifiers;
- privacy review before public rollout.
Detection:
- privacy telemetry review;
- red-team traffic analysis.
Recovery:
- rotate transport metadata where protocol allows;
- change topic strategy;
- disable P2P discovery without affecting funds.
Mandatory test:
- traffic-analysis review quantifies metadata leakage before public rollout.
Gate: privacy review / future P2P discovery gate

### AE-P2P-008 — Malicious peer triggers internal or private-network connections
Component: peer retrieval / multiaddr handling
Severity: CRITICAL
Threat source: malicious peer
Preconditions: untrusted peer supplies arbitrary address/redirect
Failure path: node dials localhost, metadata service, DB/Redis/internal service
Impact: SSRF, credential exposure, lateral movement
Prevention:
- multiaddr/IP validation;
- deny loopback/private/link-local/metadata/internal ranges by default;
- no HTTP redirect trust;
- dedicated network namespace/egress ACL;
- explicit exception only for local wallet-agent channel outside P2P path.
Detection:
- denied-dial telemetry;
- network flow logs.
Recovery:
- disconnect peer; quarantine offending record/source.
Mandatory test:
- peer-supplied localhost/RFC1918/cloud-metadata destinations are rejected.
Gate: G1 / future P2P discovery gate

### AE-P2P-009 — Peer score mistaken for economic trust
Component: Gossipsub scoring
Severity: HIGH
Threat source: design error
Preconditions: high network reputation bypasses signature/state checks
Failure path: well-scored peer sends stale or malicious economic message accepted without full verification
Impact: integrity failure
Prevention:
- score gates transport only;
- every offer/cancel/accept validated cryptographically and against state;
- no score-based bypass.
Detection:
- code review/static policy checks.
Recovery:
- revoke bypass; replay authoritative state.
Mandatory test:
- highest-scored peer with invalid signature is rejected identically to unknown peer.
Gate: G2 / future P2P discovery gate

### AE-P2P-010 — Discovery outage blocks active trade recovery
Component: P2P discovery availability
Severity: CRITICAL
Threat source: network partition, DDoS, software failure
Preconditions: recovery instructions or counterparty data fetched only from discovery network
Failure path: P2P unavailable during refund window
Impact: stranded funds
Prevention:
- export recovery bundle before lock;
- final terms stored locally;
- no active-trade recovery dependency on Gossipsub/DHT/bootstrap.
Detection:
- disaster drill;
- dependency graph audit.
Recovery:
- standalone recovery tool / chain RPC path.
Mandatory test:
- disable entire discovery subsystem after lock and complete refund independently.
Gate: G3/G7

---

## L. Formal invariants to prove/model

At minimum the formal model must enforce:

1. NEVER COMPLETED && REFUNDED.
2. NEVER two successful fills for one whole-fill offer.
3. NEVER unsigned or mutated terms reach settlement.
4. NEVER a stale mode epoch authorizes a new fund commitment.
5. NEVER a mode transition disables a valid redeem/refund/recovery path.
6. NEVER a cache-only state transition commits financial truth.
7. NEVER a duplicate worker execution creates a second logical fund-critical action.
8. Under documented protocol assumptions, an honest participant retains either the asset or a valid
   completion/refund path.
9. A reorg can invalidate prior confirmation state without violating invariants.
10. Quarantine can stop new exposure without destroying existing recovery rights.

Gate: G4

---

## M. Current release blockers

Before any executable settlement code:
- G0 isolation evidence incomplete;
- component-level network topology not finalized;
- threat register requires review and ownership assignment;
- protocol specification absent;
- recovery specification absent;
- mode transition specification absent;
- asset risk model absent;
- license matrix absent;
- formal model absent.

Before any real funds:
- all G0-G8 evidence applicable to first protocol must pass;
- no CRITICAL open vulnerability;
- independent security review complete;
- crash/reorg/fee-spike/refund drills complete;
- Mainnet canary limits and incident response ready.

---

## N. Review rule

After completing any security work item:

1. verify implementation/spec against its threat entries;
2. perform negative/adversarial tests;
3. attempt to violate stated invariants;
4. review blast radius into GPUbnb Core;
5. review recovery behavior;
6. review new dependencies and privileges;
7. record residual risk;
8. only then mark the item complete.

Completion without re-verification is not accepted.
