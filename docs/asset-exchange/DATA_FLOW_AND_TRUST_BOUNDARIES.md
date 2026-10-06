# GPUbnb Asset Exchange — Data Flow and Trust Boundaries v0

Status: WORKING DRAFT / PRE-DEVELOPMENT / NO REAL FUNDS

## 1. Purpose

This document defines the initial data-flow model, trust boundaries, failure isolation rules and
allowed integration surfaces for the GPUbnb Asset Exchange, branded "gpu.k.p2p" in the user interface.

It is a security architecture document. It does not authorize real-funds settlement.

## 2. Primary isolation objective

The Asset Exchange is a separate security and availability domain from GPUbnb Core.

The following must remain operational if the entire Asset Exchange is unavailable, deleted,
misconfigured, compromised or under incident response:

- GPU rental;
- mining;
- machines;
- workspaces;
- agents;
- GPUbnb Core account authentication;
- the existing renter/host QUIC P2P data plane.

No Asset Exchange component may become a runtime prerequisite for those Core functions.

## 3. Logical security domains

### Domain A — GPUbnb Core

Contains existing GPUbnb functionality and its existing infrastructure.

Examples:
- Core frontend/application shell;
- Core API;
- Core PostgreSQL;
- Core Redis;
- rental/mining services;
- machines/workspaces/agents;
- existing QUIC/STUN/rendezvous infrastructure.

Security rule:
Asset Exchange must not import itself into a Core financial/control-plane execution path.

### Domain B — Asset Exchange Web

Untrusted-by-default browser execution environment.

Responsibilities:
- marketplace UI;
- offer creation UX;
- trade-room UX;
- wallet interaction orchestration;
- displaying signed terms;
- local preparation of signatures/transactions where supported.

Must never receive or persist:
- seed phrases;
- raw private keys;
- unencrypted wallet files;
- spend keys.

### Domain C — Asset Exchange API / Application Services

Responsibilities:
- marketplace discovery;
- signed-offer ingestion;
- trade orchestration;
- authorization;
- rate limiting;
- policy evaluation;
- public/session APIs.

Must be independently deployable from GPUbnb Core.

### Domain D — Asset Exchange PostgreSQL

Authoritative orchestration datastore.

Responsibilities:
- offers;
- trade events;
- idempotency records;
- mode/epoch state;
- policy/risk registry references;
- audit metadata;
- recovery metadata that is safe for server storage.

Must not be the GPUbnb Core database.

### Domain E — Asset Exchange Redis / Ephemeral Coordination

Allowed use:
- cache;
- presence;
- rate limiting;
- bounded non-critical coordination.

Forbidden use:
- sole double-fill protection;
- sole source of financial truth;
- sole source of settlement state.

### Domain F — Settlement / Protocol Engine

Responsibilities:
- versioned settlement protocol state;
- deterministic transition validation;
- pre-trade revalidation;
- lock/redeem/refund orchestration;
- recovery-state derivation.

It must not possess user private keys.

### Domain G — Chain Adapters and Watchers

Responsibilities:
- chain-specific transaction interpretation;
- confirmation/reorg tracking;
- fee/mempool observations;
- broadcast;
- capability/risk reporting.

All RPCs/explorers are fallible and potentially hostile.

Critical decisions should use independent sources where feasible.

### Domain H — Wallet Layer / Local Wallet Agent

Browser wallets, hardware wallets, external wallets and optional localhost wallet-agent belong to
the user-controlled signing boundary.

The local wallet agent must:
- bind to loopback only;
- require authenticated pairing;
- bind requests to an approved origin/session;
- use a strict method allowlist;
- expose no shell or arbitrary filesystem access;
- never expose seed/private-key export methods.

### Domain I — Policy / Risk Administration

Contains privileged controls for:
- deployment mode;
- chain status;
- asset status;
- limits;
- settlement enablement;
- RPC configuration;
- protocol configuration.

High-risk administrative changes require strong reauthentication and auditable authorization.

### Domain J — External Networks and Counterparties

Always untrusted:
- blockchain networks;
- counterparties;
- public RPC providers;
- explorers;
- token metadata sources;
- third-party APIs;
- future public P2P peers.

## 4. Allowed Core ↔ Asset Exchange integration

Only narrowly scoped integration is permitted.

Allowed:
1. navigation / routing;
2. branding consistency;
3. optional short-lived signed identity bridge.

Forbidden:
- shared settlement datastore;
- shared financial Redis state;
- shared private-key material;
- Asset Exchange dependency for Core authentication;
- Core rental/mining dependency on Asset Exchange availability;
- silent reuse of Core production secrets.

## 5. Optional signed identity bridge

Target flow:

GPUbnb authenticated user
→ Core issues short-lived signed identity ticket
→ browser sends ticket to Asset Exchange
→ Asset Exchange verifies signature, audience, expiry, nonce and issuer
→ Asset Exchange creates its own session

The ticket should contain the minimum information required.

Prefer:
- opaque GPUbnb subject identifier;
- issuer;
- audience;
- issued-at;
- expiry;
- nonce / unique token identifier;
- protocol/version identifier.

Avoid embedding:
- wallet history;
- blockchain addresses not required for login;
- broad Core authorization state;
- sensitive profile attributes.

The Asset Exchange must remain capable of invalidating its own session independently.

## 6. Marketplace offer flow

1. User selects give/want assets using canonical asset identities.
2. Amounts are converted to integer atomic units.
3. Client prepares canonical versioned offer payload.
4. User signs the offer with domain separation.
5. API verifies syntax, version, signature and policy.
6. API stores offer plus immutable signed payload reference.
7. Discovery exposes only intended public fields.

Public offer data should not require publication of final destination addresses.

## 7. Offer acceptance flow

1. Taker requests acceptance.
2. Server opens a database transaction.
3. Offer availability and expiry are checked.
4. Competing accept/cancel operations are serialized using database concurrency controls.
5. One acceptance may reserve/consume a whole-fill offer.
6. Both parties exchange and sign immutable settlement terms.
7. Only signed terms may enter protocol preparation.

Redis must never decide the winner of an accept/cancel race.

## 8. Settlement preparation flow

Before any lock transaction:

- asset identity is revalidated;
- network is revalidated;
- ownership/balance is revalidated as supported;
- transferability is revalidated;
- token/contract authorities are revalidated where relevant;
- policy/risk status is revalidated;
- mode epoch is revalidated;
- settlement protocol enablement is revalidated;
- fee/confirmation/timelock policy is recomputed;
- recovery path is confirmed available.

Failure of any required validation blocks new locking but must not block existing redeem/refund rights.

## 9. Fund-critical action flow

For each irreversible or fund-critical action:

request
→ authenticate/authorize
→ validate expected trade state
→ validate protocol version
→ validate mode epoch
→ validate idempotency key
→ construct deterministic action
→ persist intent/durable event where required
→ broadcast/sign via appropriate boundary
→ observe chain independently
→ reconcile durable state

The design must explicitly handle:

broadcast accepted
→ process crash
→ database state stale

Recovery must discover the already-broadcast transaction and must not blindly create a second
dangerous transaction.

## 10. Recovery flow

Recovery is a first-class path, not an error fallback.

Existing trades must preserve:
- redeem;
- refund;
- recovery;

even when:
- new offers are disabled;
- new trades are disabled;
- an asset is quarantined;
- maintenance is active;
- deployment mode is transitioning;
- the frontend is unavailable.

A future encrypted recovery bundle may contain only the minimum secret material required by the
specific protocol and must use authenticated encryption.

## 11. Mode transition flow

States:
- CONFORMITE;
- SOUVERAIN;
- TRANSITION.

Transition sequence:

admin strong reauthentication
→ enter TRANSITION
→ increment fencing epoch
→ disable new offers
→ disable new trades
→ keep existing settlement/redeem/refund/recovery enabled
→ drain and verify active trades
→ verify DB/workers/nodes/config
→ activate target policy
→ health checks
→ increment/activate target epoch
→ target mode ACTIVE

Stale workers holding an old epoch must be unable to authorize new operations.

## 12. Primary trust boundaries

### TB-01 Browser ↔ Asset Exchange API
Threats:
XSS, CSRF, session theft, origin confusion, malicious extensions, replay, BOLA/IDOR.

Controls:
strict CSP, secure cookies where applicable, anti-CSRF where applicable, origin validation,
authorization on every object, replay protection, bounded inputs, no trust in client-provided state.

### TB-02 Browser ↔ Wallet Provider
Threats:
malicious provider, wrong account, wrong chain, account switching, phishing.

Controls:
explicit chain/account display, re-read provider state before signing, WYSIWYS terms, domain
separation, transaction simulation where supported.

### TB-03 Browser ↔ Local Wallet Agent
Threats:
DNS rebinding, unauthorized origin, local malware, confused deputy, oversized requests.

Controls:
loopback binding, authenticated pairing, origin binding, capability-scoped methods, message size
limits, rate limits, no shell/filesystem/private-key export.

### TB-04 API ↔ PostgreSQL
Threats:
injection, race conditions, duplicate fill, lost update, partial commit.

Controls:
parameterized queries, transactions, constraints, unique keys, expected-state transitions,
append-only financial events, idempotency records.

### TB-05 API/Workers ↔ Redis
Threats:
stale cache, eviction, outage, spoofed coordination.

Controls:
never treat Redis as sole financial truth; safe fallback to PostgreSQL; bounded TTLs.

### TB-06 Watcher ↔ Blockchain RPC/Explorer
Threats:
stale/malicious RPC, false height, false fee estimate, partition, eclipse.

Controls:
independent sources for critical observations where practical, consistency checks, chain-specific
confirmation/reorg policies, fail closed for new locks when evidence is insufficient.

### TB-07 Settlement Engine ↔ Worker Queue
Threats:
duplicate delivery, reordering, worker crash, stale worker epoch.

Controls:
at-least-once assumption, dedupe, idempotency keys, expected state, protocol version, mode epoch.

### TB-08 Admin UI ↔ Policy/Risk Engine
Threats:
stolen admin session, CSRF, stale privilege, unsafe configuration mutation.

Controls:
strong reauthentication, WebAuthn/passkey/hardware-key preference, WYSIWYS challenge, challenge
invalidation on mutation, immutable audit trail.

### TB-09 Asset Exchange ↔ GPUbnb Core Identity Bridge
Threats:
ticket replay, wrong audience, long-lived privilege, identity over-sharing.

Controls:
short expiry, signed audience-bound ticket, nonce/jti, strict issuer verification, minimal claims,
independent Asset Exchange session.

### TB-10 Build/Release ↔ Production
Threats:
malicious dependency/action/image, artifact substitution, rollback/freeze.

Controls:
pinned dependencies/actions where practical, SBOM, provenance, signed artifacts, protected
environments, secret scanning, SAST/dependency/container scanning, verifiable release metadata.

## 13. Data classification

### Class S0 — Never server-side
- seed phrase;
- private key;
- raw wallet file;
- spend key;
- wallet password;
- temporary secret material not explicitly required by a reviewed protocol.

### Class S1 — Highly sensitive
- recovery secrets where protocol requires server-visible encrypted material;
- session tokens;
- admin authentication artifacts;
- swap/adaptor material;
- unpublished destination addresses.

Requires encryption, strict access control, log redaction and minimal retention.

### Class S2 — Sensitive operational
- signed terms;
- wallet ownership proofs;
- trade history;
- risk/policy decisions;
- chain observations.

### Class S3 — Public or intended-public
- selected offer fields;
- public asset registry metadata;
- published status/incident information.

Classification is contextual: a blockchain address may be public on-chain but still privacy-sensitive
inside GPUbnb because correlation with identity/trade history creates additional risk.

## 14. Privacy boundary

Do not design a single convenience table that automatically correlates:

real identity + IP + GPUbnb account + BTC/XMR/DOGE addresses + full trade history.

Prefer logical and, where practical, physical separation between identity and exchange datasets.
Collect only what is required for operation, security and configured policy obligations.

## 15. Network isolation requirements

Target architecture should support:
- separate service identities;
- separate secret namespaces;
- separate databases;
- separate Redis/cache;
- separate deploys;
- network egress controls for chain/RPC access;
- explicit denial of RPC access to localhost, cloud metadata, internal Redis/Postgres and internal
  admin services;
- separate observability/audit controls.

## 16. Failure invariants

The following failures must not break GPUbnb Core:
- Asset Exchange API down;
- Asset Exchange database down;
- Asset Exchange Redis down;
- chain node down;
- watcher down;
- settlement worker down;
- policy/risk service down;
- Asset Exchange frontend removed.

Within Asset Exchange, failures must degrade safely:
- insufficient chain evidence blocks new fund commitments;
- policy uncertainty blocks new trades, not recovery;
- cache failure falls back to durable truth;
- worker duplication does not duplicate fund-critical effects;
- stale mode epoch cannot authorize new operations.

## 17. G0/G1 evidence required next

Before G0/G1 can pass, produce evidence for:

1. deploy topology diagram;
2. database separation plan;
3. secrets separation plan;
4. network/egress policy;
5. Core outage/deletion independence test plan;
6. component-level threat register with IDs;
7. privacy data inventory and retention policy;
8. admin authorization model;
9. RPC isolation/SSRF design;
10. supply-chain trust map.

## 18. Open questions

These require explicit design decisions before implementation:

- whether Asset Exchange remains in the monorepo or moves to a separate repository;
- exact identity-ticket signing authority and rotation model;
- exact database/service topology per deployment mode;
- whether policy identity data is physically separated from trade data;
- recovery-bundle custody and encryption model;
- chain-specific independent-observation strategy;
- which first UTXO pair is used for regtest protocol validation.

## 19. Non-authorization statement

This document is architecture evidence only.

It does not authorize:
- Mainnet settlement;
- custody;
- collection of user private keys;
- claims that any asset is SECURE;
- bypassing SECURITY_GATES.md.
