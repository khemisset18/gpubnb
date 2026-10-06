# gpu.k.p2p — Network and Deployment Architecture v0

Status: G0 WORKING DRAFT / PRE-DEVELOPMENT / NO REAL FUNDS

## 1. Objective

This document defines the target network, deployment and infrastructure isolation model for
gpu.k.p2p, the user-facing brand of the GPUbnb Asset Exchange.

The technical subsystem name remains asset-exchange.

Primary invariant:

gpu.k.p2p compromise, outage, deletion or maintenance MUST NOT break GPUbnb Core.

GPUbnb Core includes rental, mining, machines, workspaces, agents, account authentication and the
existing QUIC/STUN/rendezvous data plane.

## 2. Current Core observation

The current GPUbnb Core production configuration already has its own:

- Render web service;
- worker service;
- DATABASE_URL;
- REDIS_URL;
- SESSION_SECRET;
- INTERNAL_SERVICE_TOKEN;
- Solana configuration;
- production deployment lifecycle.

gpu.k.p2p MUST NOT reuse those runtime resources or credentials.

The existence of a resource in the same monorepo does not grant the Asset Exchange permission to use
it.

## 3. G0 architecture principle

The desired architecture is two security domains:

GPUbnb Core
and
gpu.k.p2p / asset-exchange

They may share branding and repository history, but they do not share financial runtime state.

Target separation:

Core database != Asset Exchange database
Core Redis != Asset Exchange Redis
Core secrets != Asset Exchange secrets
Core service identity != Asset Exchange service identity
Core workers != Asset Exchange workers
Core deployment != Asset Exchange deployment
Core logs != Asset Exchange sensitive logs
Core incident domain != Asset Exchange incident domain

## 4. Target high-level topology

Internet
  |
  +-- GPUbnb Core public edge
  |     |
  |     +-- Core Web/API
  |     +-- Core Workers
  |     +-- Core PostgreSQL
  |     +-- Core Redis
  |     +-- Existing GPU rental/mining/QUIC systems
  |
  +-- gpu.k.p2p public edge
        |
        +-- Asset Exchange Web
        +-- Asset Exchange API
        +-- Trade Orchestrator
        +-- Policy/Risk Engine
        +-- Settlement Engine
        +-- Worker Queue
        +-- Chain Watchers
        +-- RPC Egress Gateway
        +-- Asset Exchange PostgreSQL
        +-- Asset Exchange Redis
        +-- Audit/Observability
        +-- Recovery Services

Optional narrow bridge:

GPUbnb Core Identity Signer
   ->
short-lived signed identity ticket
   ->
Asset Exchange Identity Verifier

No reverse dependency from Core to Exchange is allowed.

## 5. Trust zones

### Z0 — Public Internet

Contains:

- end-user browsers;
- malicious clients;
- bots;
- third-party websites;
- public blockchain peers and endpoints.

Trust level: NONE.

### Z1 — Public Web Edge

Contains:

- CDN/WAF/reverse proxy;
- static web frontend;
- public TLS termination where architecture requires it.

Allowed inbound:

- HTTPS only;
- WSS only where explicitly required.

Forbidden:

- direct DB access;
- direct Redis access;
- direct internal worker access;
- direct private RPC management access.

### Z2 — Asset Exchange Application Zone

Contains:

- asset-exchange-api;
- marketplace service;
- trade orchestration;
- session service;
- public API authorization logic.

Inbound:

- only from approved public edge/service mesh paths.

Outbound:

- Asset Exchange PostgreSQL;
- Asset Exchange Redis for non-authoritative ephemeral state;
- internal policy/risk services;
- internal settlement coordination;
- narrowly scoped identity verification interface;
- controlled RPC gateway only when needed.

No direct access to Core PostgreSQL or Core Redis.

### Z3 — Settlement Security Zone

Contains:

- settlement engine;
- protocol state validation;
- transaction construction logic;
- recovery state logic.

This zone is more privileged than the normal application zone.

Rules:

- no public inbound access;
- never stores seed phrases/private keys;
- no arbitrary outbound internet;
- only approved chain adapters/RPC gateway;
- only dedicated Asset Exchange database;
- explicit service authentication;
- minimum exposed API.

### Z4 — Chain Observation / RPC Zone

Contains:

- chain adapters;
- watchers;
- RPC egress gateway;
- optional self-hosted blockchain nodes.

Purpose:

separate hostile/fallible blockchain infrastructure from application and settlement zones.

RPC endpoints are treated as untrusted.

All outbound RPC requests must pass through controlled policy.

### Z5 — Data Zone

Contains:

- Asset Exchange PostgreSQL;
- Asset Exchange Redis;
- optional durable event store if separated later.

No public ingress.

Only explicit service identities may connect.

PostgreSQL is authoritative for orchestration.

Redis is never authoritative for financial decisions.

### Z6 — Administration Zone

Contains:

- admin interface;
- policy/risk administration;
- security operations;
- release controls.

Rules:

- not publicly equivalent to user UI;
- strong authentication;
- fresh reauthentication for critical operations;
- WebAuthn/passkey/hardware-key preferred;
- network restrictions where practical;
- immutable audit of critical changes.

### Z7 — Recovery Zone

Contains:

- recovery orchestration;
- refund tools;
- recovery bundle support;
- emergency operational functions.

Goal:

recovery remains reachable when normal marketplace components are disabled.

This zone must not depend on feature flags that disable new trading.

### Z8 — Observability / Audit Zone

Contains:

- sanitized logs;
- metrics;
- security alerts;
- audit events.

No wallet seeds/private keys/session secrets/recovery secrets may be logged.

Production operational logs and audit evidence should be separable.

### Z9 — GPUbnb Core Zone

Existing Core infrastructure.

Asset Exchange access is denied by default.

Only explicitly approved identity-bridge traffic may cross the boundary.

## 6. Default network policy

Global rule:

DENY by default.

Allow only documented source -> destination -> protocol -> port -> purpose.

No service receives broad east-west access because it is "internal".

## 7. Required allowlist matrix

### Public user -> Asset Exchange Web

Allow:
- HTTPS 443.

### Public user -> Asset Exchange API

Allow through approved edge only:
- HTTPS 443;
- WSS when Trade Room requires it.

No direct origin bypass.

### Asset Exchange API -> Asset Exchange PostgreSQL

Allow:
- PostgreSQL TLS connection using dedicated credentials.

No access to Core PostgreSQL.

### Asset Exchange API -> Asset Exchange Redis

Allow:
- TLS/private Redis connection using dedicated credentials.

Redis may hold:
- rate-limit data;
- cache;
- presence;
- ephemeral coordination.

### Settlement Engine -> Asset Exchange PostgreSQL

Allow:
- dedicated DB role;
- only required schemas/tables/actions.

### Settlement Engine -> RPC Gateway

Allow only:
- approved internal RPC gateway interface.

Settlement engine should not have general internet egress.

### Watchers -> RPC Gateway / chain nodes

Allow:
- explicit chain-specific endpoints.

### RPC Gateway -> public/self-hosted chain endpoints

Allow:
- destination allowlist / validated policy.

Deny:
- arbitrary hostnames supplied directly by users;
- localhost;
- loopback;
- link-local;
- cloud metadata;
- Core DB;
- Core Redis;
- internal admin endpoints;
- private service ranges unless explicitly required and isolated.

### Asset Exchange -> Core Identity Bridge

Allow:
- minimal signed ticket verification/issuance flow;
- dedicated audience and protocol.

Deny:
- general Core API access;
- Core DB access;
- Core Redis access;
- reuse of Core internal service token.

## 8. Core isolation rules

The following are permanent G0 rules:

1. Asset Exchange cannot read Core DATABASE_URL.
2. Asset Exchange cannot read Core REDIS_URL.
3. Asset Exchange cannot read Core SESSION_SECRET.
4. Asset Exchange cannot read Core INTERNAL_SERVICE_TOKEN.
5. Asset Exchange migrations cannot target Core DB.
6. Asset Exchange workers cannot consume Core worker queues.
7. Core workers cannot consume Asset Exchange settlement queues.
8. Asset Exchange cannot require Core Redis availability.
9. Asset Exchange cannot require Core DB availability.
10. Core cannot require Asset Exchange availability.

## 9. Separate service identities

Each deployable receives its own identity.

Conceptual identities:

- ax-web;
- ax-api;
- ax-trade-orchestrator;
- ax-settlement;
- ax-worker;
- ax-watcher-btc;
- ax-watcher-doge;
- ax-watcher-ltc;
- ax-watcher-bch;
- ax-risk-policy;
- ax-recovery;
- ax-admin;
- ax-rpc-gateway.

No wildcard super-service credential.

A watcher should not automatically receive DB admin rights.

The web frontend receives no server secret.

## 10. Database separation

Preferred production model:

Asset Exchange PostgreSQL is a separate database service/cluster from GPUbnb Core.

Minimum requirements:

- separate endpoint;
- separate credentials;
- separate encryption keys where provider supports it;
- separate backups;
- separate restore process;
- separate migration pipeline;
- separate monitoring;
- no cross-database foreign keys;
- no Core schema imports.

Roles should be split by responsibility where practical:

- ax_api_rw;
- ax_settlement_rw;
- ax_watcher_rw or restricted event writer;
- ax_readonly_observer;
- ax_migration_admin.

Application roles must not own the database.

## 11. Database network controls

Database accepts connections only from approved Asset Exchange services.

Forbidden:

- public IP ingress where avoidable;
- browser access;
- chain RPC access;
- Core application credentials;
- arbitrary CI access from untrusted pull requests.

Migration access should be stronger and rarer than runtime access.

## 12. Redis separation

Use dedicated Asset Exchange Redis.

Requirements:

- dedicated credentials;
- TLS/private network;
- no public ingress;
- no Core keyspace;
- memory limits;
- eviction behavior understood;
- outage treated as recoverable degradation.

Financial invariant:

loss or flush of Asset Exchange Redis cannot cause a double fill or alter canonical trade state.

## 13. Secrets architecture

Use separate secret namespaces.

Conceptual namespaces:

- core/*;
- asset-exchange/prod/*;
- asset-exchange/staging/*;
- asset-exchange/dev/*.

An Asset Exchange production identity must not have permission to enumerate or read core/*.

Secrets should be scoped per service where practical.

Example:

asset-exchange/prod/api/session-key
asset-exchange/prod/api/db-credential
asset-exchange/prod/settlement/db-credential
asset-exchange/prod/rpc/btc-provider-a
asset-exchange/prod/rpc/btc-provider-b
asset-exchange/prod/admin/webauthn-config

No private user wallet key belongs in this namespace.

## 14. Secret rotation

Every service secret must have:

- owner;
- purpose;
- creation date;
- rotation policy;
- revocation procedure;
- incident procedure.

Rotation of Asset Exchange secrets must not require rotating Core credentials.

Rotation of Core secrets must not break Asset Exchange, except explicitly versioned identity-bridge
verification keys where designed.

## 15. Identity bridge network design

Identity bridge is optional.

Preferred pattern:

Core creates a signed, short-lived ticket.

Ticket includes minimum claims:

- opaque subject;
- issuer;
- audience = asset-exchange;
- issued-at;
- expiry;
- nonce/jti;
- version.

Asset Exchange verifies signature.

Asset Exchange then creates its own session.

No persistent shared session database.

No reuse of Core session cookie.

No reuse of Core SESSION_SECRET.

## 16. Browser isolation

Asset Exchange frontend is considered untrusted execution context.

Frontend may receive:

- public asset metadata;
- signed public offers;
- user session state appropriate for UI;
- wallet public addresses where needed;
- unsigned/signed transaction data intended for local user action.

Frontend must never receive server-only secrets.

Third-party scripts should be minimized on settlement pages.

## 17. Content Security Policy target

Settlement UI should target strict CSP.

Principles:

- no unsafe-inline where avoidable;
- no unsafe-eval;
- explicit script-src;
- explicit connect-src;
- explicit frame-src;
- frame-ancestors restricted;
- object-src none;
- base-uri restricted;
- trusted asset/logo origins only.

Arbitrary remote token logos should not execute or inject active content.

## 18. RPC SSRF boundary

RPC configuration is high risk.

Threat:

admin/operator configures an endpoint that resolves to internal infrastructure.

Attack targets include:

- 127.0.0.1;
- ::1;
- RFC1918 internal ranges;
- link-local;
- cloud metadata addresses;
- Kubernetes/service mesh metadata;
- Redis;
- PostgreSQL;
- internal admin panels;
- Core services.

Controls:

1. dedicated RPC egress component;
2. strict URL parsing;
3. supported schemes only;
4. DNS resolution validation;
5. revalidation after redirects;
6. no unrestricted redirects;
7. destination IP policy;
8. connection timeout;
9. response size limit;
10. request method allowlist;
11. no arbitrary headers/secrets;
12. network firewall as final enforcement.

Application-layer URL validation alone is insufficient.

## 19. Multiple RPC sources

Fund-critical observations should not blindly trust one provider.

Per-chain observation policy may require:

- self-hosted node;
- provider A;
- provider B;
- optional explorer as non-authoritative corroboration.

Decision logic must define:

- quorum;
- conflict;
- stale source;
- unavailable source;
- reorg disagreement.

On insufficient evidence:

block new irreversible commitments.

Do not automatically disable safe refund/recovery.

## 20. Egress policy

Different services receive different outbound rights.

### Web/API

Allowed:
- only required external services.

Denied:
- arbitrary internet where not required;
- blockchain RPC directly if gateway is mandatory.

### Settlement

Allowed:
- internal DB;
- internal protocol services;
- RPC gateway.

Denied:
- arbitrary public internet.

### Watchers/RPC gateway

Allowed:
- approved blockchain endpoints.

Denied:
- Core private network;
- metadata services;
- unrelated SaaS.

### Admin

Configuration writes go through controlled API, not arbitrary network access.

## 21. Ingress policy

Only Web/API edge is user-facing.

Workers, watchers, settlement, DB, Redis and recovery internals are private.

Administrative endpoints should have additional restrictions.

Health endpoints:

- reveal minimal information;
- no secrets;
- no dependency connection strings;
- no internal topology disclosure beyond operational need.

## 22. Service-to-service authentication

Network location alone is not authentication.

Use explicit service authentication.

Possible mechanisms depending on deployment platform:

- workload identity;
- mTLS;
- signed service tokens;
- short-lived credentials.

Avoid one shared INTERNAL_SERVICE_TOKEN for every Asset Exchange component.

## 23. Least privilege database roles

Example:

ax-api:
- offers;
- sessions;
- public trade orchestration records.

ax-settlement:
- settlement state/events;
- recovery state;
- restricted read of signed terms.

ax-watcher:
- chain observation tables/events only.

ax-admin:
- policy/risk changes through application authorization, not raw DB superuser access.

## 24. Worker queue isolation

Asset Exchange financial jobs use a dedicated queue/broker namespace.

Requirements:

- no Core queue reuse;
- message authentication/integrity as appropriate;
- bounded payloads;
- idempotency key;
- trade ID;
- protocol version;
- expected state;
- mode epoch.

Assume at-least-once delivery.

## 25. Recovery availability class

Recovery traffic has higher safety priority than marketplace convenience traffic.

During incident:

May disable:
- search;
- new offers;
- new trades;
- analytics;
- nonessential metadata.

Must preserve when protocol permits:
- redeem;
- refund;
- recovery;
- critical chain observation.

Rate limiting must reserve capacity for recovery.

## 26. DDoS/resource exhaustion

Public endpoints need:

- request size limits;
- connection limits;
- rate limits;
- per-identity quotas;
- expensive-operation budgets;
- backpressure;
- queue bounds.

A DDoS protection mechanism must not make refund impossible for legitimate active trades.

Emergency bypass/access strategy for recovery must be designed securely.

## 27. WebSocket zone

Trade Room WSS:

- authenticates independently;
- validates Origin;
- expires sessions;
- limits message size;
- limits message rate;
- enforces authorization per trade;
- never treats chat as signed trade authority.

No user chat message can change destination address or signed terms.

## 28. Admin network architecture

Critical admin operations include:

- change mode;
- change risk status;
- enable/disable new trades;
- change RPC;
- change settlement contract;
- change limits;
- change protocol version.

Controls:

- strong authentication;
- fresh auth challenge;
- WYSIWYS summary;
- configuration hash;
- immutable audit event;
- optional dual approval for highest-risk production changes;
- stale challenge invalidation.

## 29. CI/CD isolation

Asset Exchange deployment should have its own deployment target/environment.

No untrusted PR may receive production secrets.

Recommended:

- separate protected environment;
- minimal workflow permissions;
- pinned actions;
- artifact signing;
- provenance;
- SBOM;
- dependency scan;
- SAST;
- secret scanning;
- container scan.

A compromised Asset Exchange deployment credential should not deploy GPUbnb Core.

## 30. Deployment isolation

Recommended production deployables:

1. asset-exchange-web
2. asset-exchange-api
3. asset-exchange-worker
4. asset-exchange-settlement
5. asset-exchange-risk-policy
6. asset-exchange-rpc-gateway
7. asset-exchange-chain-watchers
8. asset-exchange-recovery

They may begin with fewer physical services if operational simplicity demands it, but security
boundaries and credentials must remain explicitly modeled.

Do not merge everything into the current Core gpubnb service.

## 31. Environment isolation

At minimum:

- development;
- test;
- staging;
- production.

Never use production private infrastructure in untrusted developer environments.

Mainnet credentials/endpoints are unavailable in normal development.

Default development and early settlement testing:

- local;
- regtest;
- devnet/testnet.

## 32. Mainnet network gate

Before any Mainnet egress is enabled:

- protocol gate passed;
- recovery gate passed;
- formal invariants reviewed;
- RPC policy tested;
- independent node/provider strategy configured;
- canary limits configured;
- quarantine controls tested;
- monitoring active;
- incident runbook exercised.

Mainnet access must not be enabled simply through a frontend feature flag.

## 33. Observability boundaries

Metrics may include:

- service health;
- queue age;
- watcher lag;
- RPC disagreement;
- reorg events;
- failed auth;
- stale mode epoch attempts;
- recovery queue age;
- policy denials.

Logs must not include:

- seed phrase;
- private key;
- wallet password;
- raw sensitive recovery secret;
- session cookie;
- bearer token;
- unredacted admin challenge secrets.

## 34. Audit trail

Critical events should be append-only or tamper-evident where practical.

Examples:

- policy change;
- mode change;
- asset quarantine;
- RPC endpoint change;
- contract/protocol config change;
- privileged login;
- settlement capability change;
- recovery override procedure.

Audit storage should not depend solely on the same system an attacker is modifying.

## 35. Backup architecture

Asset Exchange backups are independent from Core backups.

Requirements:

- encrypted;
- access-controlled;
- restore-tested;
- retention policy;
- recovery point objective documented;
- recovery time objective documented.

Backups must not silently include forbidden wallet secrets because such secrets should never be stored.

## 36. Disaster scenarios

G0/G3 planning must include:

### Scenario A
Asset Exchange API destroyed.

Expected:
Core works.
Recovery path can be restored independently.

### Scenario B
Asset Exchange DB unavailable.

Expected:
No unsafe new financial transitions.
Core works.
Recovery runbook activated.

### Scenario C
Asset Exchange Redis flushed.

Expected:
No canonical financial data lost.
No double fill.
Core works.

### Scenario D
RPC provider malicious.

Expected:
Disagreement detected.
New locking paused.
Recovery remains prioritized.

### Scenario E
Settlement worker duplicated.

Expected:
Idempotency prevents duplicate logical effect.

### Scenario F
Asset Exchange credentials stolen.

Expected:
Attacker cannot authenticate to Core DB/Redis/secrets.

### Scenario G
Core outage.

Expected:
Existing Asset Exchange sessions/trades follow documented behavior.
Active recovery must not rely on continuous Core availability.

### Scenario H
gpu.k.p2p frontend removed.

Expected:
documented recovery route exists for already committed trades.

## 37. G0 destructive isolation tests

Before G0 PASS, intentionally test:

1. stop Asset Exchange API;
2. stop Asset Exchange Redis;
3. stop Asset Exchange DB;
4. kill all watchers;
5. disable RPC egress;
6. revoke Asset Exchange secrets;
7. delete Asset Exchange frontend;
8. flood Asset Exchange public endpoints;
9. attempt connections from Exchange to Core DB;
10. attempt connections from Exchange to Core Redis;
11. attempt to read Core secret namespace;
12. attempt internal SSRF via RPC configuration.

Expected global invariant:

GPUbnb Core remains healthy.

## 38. Core credential denial tests

From every Asset Exchange service identity:

- Core DATABASE_URL must be unavailable;
- Core REDIS_URL must be unavailable;
- Core SESSION_SECRET must be unavailable;
- Core INTERNAL_SERVICE_TOKEN must be unavailable.

If infrastructure platform cannot express this separation cleanly, G0 is not passed.

## 39. Asset Exchange credential compartmentalization tests

Compromise simulation:

### ax-web compromised
Must not yield server DB credentials or signing secrets.

### ax-api compromised
Must not yield Core credentials or user private keys.

### ax-watcher compromised
Must not gain admin policy authority.

### ax-settlement compromised
Must not gain user private keys or unrestricted Core access.

### ax-admin session compromised
Strong reauthentication and policy controls must limit silent critical changes.

## 40. DNS and domain architecture

User-facing brand: gpu.k.p2p.

Technical service DNS should remain explicit and independent.

Conceptual examples:

- app.<exchange-domain>
- api.<exchange-domain>
- recovery.<exchange-domain>
- admin.<restricted-domain>
- internal service names not publicly resolvable where possible.

Do not assume the display brand itself is necessarily a DNS-valid production domain.
Domain registration, DNSSEC, certificate policy and phishing protection require a separate review
before production naming is finalized.

## 41. TLS

All external traffic uses modern TLS.

Internal sensitive traffic should use encrypted transport where platform supports it.

Certificate validation cannot be disabled for RPC convenience.

Custom/self-signed blockchain endpoints require explicit trust configuration, not insecure skip-verify.

## 42. DNS security

Risks:

- DNS hijacking;
- poisoned RPC hostname;
- rebinding;
- domain expiry;
- malicious subdomain takeover.

Controls:

- registrar MFA/hardware key;
- domain lock;
- controlled DNS changes;
- certificate monitoring;
- DNSSEC where operationally appropriate;
- no dangling DNS records;
- RPC IP revalidation.

## 43. Cloud metadata protection

All Asset Exchange workloads should be unable to reach cloud metadata unless strictly necessary.

RPC gateway must explicitly deny metadata IPs/hostnames.

Application SSRF defenses must not be the only control.

## 44. Container/workload hardening

Target controls:

- non-root where possible;
- read-only filesystem where practical;
- dropped Linux capabilities;
- no privileged containers;
- no host Docker socket;
- minimal base image;
- pinned image digest for sensitive production components;
- resource limits;
- seccomp/AppArmor or platform equivalent where available.

## 45. Dependency on managed platforms

Managed platform compromise or outage is part of the threat model.

Do not assume Render/Netlify/DB provider are infallible.

Critical recovery documentation should be exportable and not exist only inside one provider.

## 46. No shared convenience shortcut

The following shortcuts are forbidden without a new explicit G0 review:

- reuse Core DATABASE_URL "temporarily";
- reuse Core Redis with another key prefix;
- reuse Core SESSION_SECRET;
- reuse Core INTERNAL_SERVICE_TOKEN;
- place settlement logic inside existing Core API process;
- run chain watchers inside Core worker for convenience;
- give Asset Exchange access to all monorepo production secrets.

Temporary insecure architecture tends to become permanent.

## 47. Recommended initial physical deployment

For the first marketplace-only phase:

Public:
- asset-exchange-web;
- asset-exchange-api.

Private:
- asset-exchange-postgres;
- asset-exchange-redis;
- asset-exchange-worker;
- asset-exchange-policy-risk.

No Mainnet settlement capability.

For regtest settlement phase add:

- asset-exchange-settlement;
- asset-exchange-rpc-gateway;
- specific UTXO watcher(s);
- asset-exchange-recovery.

Do not deploy 30 chain watchers initially.

## 48. G0 evidence checklist

G0 remains BLOCKED until evidence exists for:

- [ ] dedicated DB provision plan;
- [ ] dedicated Redis provision plan;
- [ ] dedicated service identities;
- [ ] dedicated secrets namespace;
- [ ] dedicated deployment targets;
- [ ] network deny-by-default matrix;
- [ ] Core credential denial test;
- [ ] SSRF/RPC egress test design;
- [ ] destructive isolation test plan;
- [ ] backup/restore separation plan;
- [ ] identity bridge design;
- [ ] incident isolation procedure.

## 49. Current status

Architecture design: DRAFTED.
Implementation: NOT STARTED.
Production infrastructure: NOT PROVISIONED.
Mainnet: FORBIDDEN.

This is intentional.

## 50. Review rule

Before any infrastructure implementation based on this document:

1. compare current main HEAD;
2. compare current deployment files;
3. verify no concurrent Core work conflicts;
4. review every required Core/Exchange network edge;
5. attempt to remove every unnecessary edge;
6. verify recovery remains reachable;
7. verify no Core secret/resource is reused;
8. perform adversarial review;
9. only then provision isolated infrastructure.
