# gpu.k.p2p — G0 Isolation, IAM, Data and Recovery Plan v0

Status: G0 WORKING DRAFT / PRE-DEVELOPMENT / NO REAL FUNDS

## 1. Purpose

This document turns the G0 isolation architecture into an implementation-ready security plan.

It defines:
- service identities;
- network permissions;
- database roles;
- Redis boundaries;
- secret namespaces;
- CI/CD separation;
- backup/restore separation;
- negative tests;
- disaster-recovery tests;
- release blockers.

No runtime implementation is authorized until this plan is reviewed.

## 2. Security objective

A compromise of any single gpu.k.p2p component must not automatically compromise:
- GPUbnb Core;
- every other Asset Exchange service;
- all Asset Exchange secrets;
- recovery capability.

Blast radius must be bounded by design.

## 3. Service inventory

Initial logical services:

- ax-web
- ax-api
- ax-trade
- ax-policy
- ax-settlement
- ax-worker
- ax-rpc-gateway
- ax-watcher-utxo
- ax-recovery
- ax-admin
- ax-migrations
- ax-observability

Future chain-specific watcher identities may replace shared watcher identities.

## 4. Identity rules

Every deployable receives a dedicated runtime identity.

Forbidden:
- one global production token;
- one shared DB superuser;
- one shared Redis password reused everywhere;
- Core INTERNAL_SERVICE_TOKEN reuse;
- Core SESSION_SECRET reuse;
- wildcard secret read permissions.

Preferred:
- short-lived workload identity;
- mTLS/service identity;
- scoped database credentials;
- narrowly scoped secret access.

## 5. Network matrix

### ax-web
Inbound:
- public HTTPS through CDN/WAF only.

Outbound:
- ax-api public/internal endpoint as required.

Denied:
- PostgreSQL;
- Redis;
- settlement;
- RPC;
- Core private services;
- secret manager server credentials.

### ax-api
Inbound:
- approved edge only.

Outbound:
- Asset Exchange PostgreSQL;
- Asset Exchange Redis;
- ax-trade;
- ax-policy;
- optional Core identity-ticket verification path.

Denied:
- Core PostgreSQL;
- Core Redis;
- Core internal service token;
- arbitrary blockchain RPC where gateway policy applies.

### ax-trade
Inbound:
- ax-api only.

Outbound:
- Asset Exchange PostgreSQL;
- ax-policy;
- ax-settlement for approved prepared trades.

Denied:
- public internet;
- Core private services;
- direct user wallet signing.

### ax-policy
Inbound:
- ax-api;
- ax-trade;
- ax-admin for authenticated changes.

Outbound:
- Asset Exchange PostgreSQL;
- approved policy data sources if configured.

Denied:
- settlement signing;
- Core DB/Redis.

### ax-settlement
Inbound:
- ax-trade;
- ax-worker;
- ax-recovery for state-safe operations.

Outbound:
- Asset Exchange PostgreSQL;
- ax-rpc-gateway.

Denied:
- public ingress;
- arbitrary internet;
- Core DB/Redis;
- user private-key storage.

### ax-worker
Inbound:
- private queue only.

Outbound:
- Asset Exchange PostgreSQL;
- ax-settlement;
- ax-policy where needed.

Denied:
- Core queues;
- Core DB/Redis;
- unrestricted internet.

### ax-rpc-gateway
Inbound:
- ax-settlement;
- watchers.

Outbound:
- allowlisted blockchain endpoints only.

Denied:
- Core networks;
- private RFC1918 ranges unless explicitly approved for isolated self-hosted nodes;
- localhost;
- link-local;
- cloud metadata;
- arbitrary redirects;
- Redis/Postgres/admin endpoints.

### ax-watcher-utxo
Inbound:
- none public.

Outbound:
- ax-rpc-gateway;
- restricted write/read access to Asset Exchange DB.

Denied:
- admin APIs;
- Core infra.

### ax-recovery
Inbound:
- dedicated recovery edge or internal path according to deployment.

Outbound:
- Asset Exchange PostgreSQL;
- ax-settlement;
- ax-rpc-gateway.

Denied:
- feature-flag dependency that can disable refund;
- Core DB/Redis.

### ax-admin
Inbound:
- restricted admin edge;
- strong authentication required.

Outbound:
- ax-policy;
- approved control APIs;
- audit sink.

Denied:
- direct raw DB mutation for normal admin workflows;
- unrestricted secret retrieval.

### ax-migrations
Inbound:
- CI/deployment only.

Outbound:
- Asset Exchange PostgreSQL.

Denied:
- Core PostgreSQL.

Credential must be unavailable to runtime services.

### ax-observability
Inbound:
- sanitized telemetry from Asset Exchange services.

Outbound:
- monitoring/alert targets.

Denied:
- production wallet secrets;
- raw session cookies;
- private keys.

## 6. Database model

Production target:
dedicated PostgreSQL service or cluster for Asset Exchange.

Minimum logical schemas:
- identity_bridge_metadata
- marketplace
- trades
- settlement
- risk_policy
- audit
- recovery_metadata

Separation may later become multiple physical databases if threat/risk warrants it.

## 7. Database roles

### ax_api_rw
Allowed:
- marketplace/session-related tables;
- offer reads/writes;
- non-fund-critical trade orchestration records.

Denied:
- schema ownership;
- migration rights;
- direct privileged settlement mutation;
- Core schemas.

### ax_trade_rw
Allowed:
- trade state/events;
- reservations;
- signed-term references.

Denied:
- migrations;
- admin policy ownership;
- Core DB.

### ax_settlement_rw
Allowed:
- settlement event append;
- idempotency records;
- recovery state required for protocol.

Denied:
- broad marketplace admin rights;
- schema ownership;
- Core DB.

### ax_watcher_rw
Allowed:
- chain observations;
- confirmation/reorg events.

Denied:
- trade acceptance;
- policy changes;
- admin changes.

### ax_policy_rw
Allowed:
- risk state;
- policy versions;
- mode state with controlled procedures.

Denied:
- settlement event fabrication.

### ax_audit_append
Allowed:
- append audit records.

Denied:
- update/delete existing audit rows where append-only mechanism is available.

### ax_readonly
Allowed:
- support/observability reads with sensitive columns masked where possible.

### ax_migration_owner
Allowed:
- schema changes only through reviewed migration pipeline.

Unavailable to normal runtime.

## 8. Database constraints required

Use database-enforced invariants where possible:

- unique whole-fill reservation;
- unique idempotency operation key;
- immutable signed-term hash references;
- monotonic mode epoch;
- valid state-transition constraints where practical;
- no duplicate critical event identifiers;
- foreign keys within Asset Exchange only.

Do not rely solely on application logic for critical uniqueness.

## 9. Migration safety

Every migration must:
- target explicit Asset Exchange DB identifier;
- fail if connected to Core DB;
- check expected schema marker;
- run under migration-only identity;
- be reviewed before production;
- be reversible when practical;
- document destructive operations.

Add a database sentinel:

ASSET_EXCHANGE_DATABASE=true

Migration tooling must refuse to run without the expected sentinel and expected database identity.

## 10. Redis plan

Dedicated Asset Exchange Redis only.

Allowed data:
- cache;
- presence;
- rate limit state;
- short-lived noncritical coordination.

Forbidden as sole source:
- offer fill winner;
- settlement state;
- refund eligibility;
- mode epoch;
- critical idempotency truth.

Redis outage policy:
- degrade noncritical UX;
- preserve durable DB truth;
- block unsafe new operations if required;
- never lose recovery rights.

## 11. Secret namespaces

Suggested hierarchy:

asset-exchange/dev/...
asset-exchange/test/...
asset-exchange/staging/...
asset-exchange/prod/...

Per-service examples:

asset-exchange/prod/api/db
asset-exchange/prod/api/session
asset-exchange/prod/trade/db
asset-exchange/prod/settlement/db
asset-exchange/prod/rpc/provider-a
asset-exchange/prod/rpc/provider-b
asset-exchange/prod/admin/webauthn
asset-exchange/prod/recovery/...

Core secrets stay under independent Core namespace.

## 12. Secret access matrix

### ax-web
No server secrets.

### ax-api
Can read:
- own DB credential;
- own session signing/encryption secrets;
- identity-bridge verification material where needed.

Cannot read:
- settlement secrets;
- RPC provider secrets unless API directly needs them;
- Core secrets.

### ax-settlement
Can read:
- own DB credential;
- protocol configuration secrets if any;
- no user wallet private keys.

### ax-rpc-gateway
Can read:
- RPC provider credentials only.

Cannot read:
- DB superuser;
- admin auth secrets;
- Core secrets.

### ax-admin
Can use admin authentication configuration.

Should not automatically be able to dump all service secrets.

### ax-migrations
Can read:
- migration DB credential only during deployment.

## 13. Secret rotation tests

For every secret:
- rotate without Core restart;
- revoke old value;
- confirm stale workload fails safely;
- confirm recovery functions remain available where applicable;
- record audit event.

## 14. Backup plan

Separate Asset Exchange backups.

Backup categories:
- PostgreSQL;
- policy/risk configuration;
- audit evidence;
- recovery metadata;
- deployment configuration.

Redis backup is not required for financial correctness.

Backups must be:
- encrypted;
- access controlled;
- integrity checked;
- restore tested;
- separate from Core backup credentials.

## 15. Restore plan

Restore must never overwrite Core.

Required restore checks:
- target environment identity;
- target DB sentinel;
- expected schema;
- backup provenance/hash;
- operator confirmation;
- post-restore integrity checks.

Restore drill:
- restore Asset Exchange staging from backup;
- validate event consistency;
- verify no Core dependency.

## 16. RPO/RTO classification

Before production define explicit targets.

Suggested security classes:

Critical recovery metadata:
- lowest practical RPO;
- priority restore.

Trade/event history:
- low RPO.

Marketplace cache:
- rebuildable.

Audit evidence:
- durable and separately protected.

Exact numerical RPO/RTO values require infrastructure/provider decisions.

## 17. CI/CD isolation

Asset Exchange must have independent deploy permissions.

Required:
- dedicated protected environment;
- no production secrets in pull-request jobs;
- minimal GitHub token permissions;
- pinned third-party actions;
- separate deploy credential from Core;
- artifact hash;
- SBOM;
- provenance;
- signed release where supported.

Compromise of Asset Exchange deploy token must not deploy Core.

## 18. Build separation

Even inside the monorepo:

- Asset Exchange packages have explicit dependency boundaries;
- no imports from Core private internals except approved bridge contracts;
- CI detects forbidden imports;
- deployment artifact contains only required Asset Exchange components.

Future option:
move Asset Exchange to a separate repository if isolation needs exceed monorepo controls.

## 19. Dependency policy

Every new runtime dependency requires:
- purpose;
- owner;
- version;
- license;
- supply-chain risk;
- maintenance status;
- transitive dependency review proportionate to risk.

No dependency added only for convenience in fund-critical code without review.

## 20. Negative network tests

Tests must verify failure, not only success.

From ax-api:
- connection to Core DB must fail;
- connection to Core Redis must fail;
- access to Core admin endpoint must fail.

From ax-settlement:
- arbitrary HTTPS destination must fail if not allowlisted;
- metadata IP must fail;
- localhost must fail.

From ax-rpc-gateway:
- metadata endpoint must fail;
- Core private IPs must fail;
- Redis/Postgres ports must fail.

From ax-web:
- DB connection impossible;
- Redis connection impossible.

## 21. Negative secret tests

From each service identity attempt to access:
- Core DATABASE_URL;
- Core REDIS_URL;
- Core SESSION_SECRET;
- Core INTERNAL_SERVICE_TOKEN;
- unrelated Asset Exchange service secrets.

Expected: DENIED.

## 22. Negative database tests

- ax_watcher cannot modify offers;
- ax_api cannot alter settlement event history;
- ax_settlement cannot execute migrations;
- runtime roles cannot drop schema;
- Core credentials cannot be used through Asset Exchange paths.

## 23. Negative Redis tests

Flush Asset Exchange Redis.

Expected:
- no canonical trade state loss;
- no duplicate fills;
- no refund loss;
- no Core impact.

## 24. Core outage test

Disable Core API and Core Redis.

Expected:
- gpu.k.p2p new-login behavior follows documented identity-bridge policy;
- existing Asset Exchange sessions remain governed by their own expiry;
- active trade recovery does not depend on Core availability;
- no fund loss.

## 25. Asset Exchange outage test

Disable:
- ax-api;
- ax-worker;
- ax-policy;
- ax-rpc-gateway;
- Exchange Redis.

Expected:
- GPUbnb Core rental/mining/machines/workspaces/accounts remain functional.

## 26. Compromised ax-api scenario

Assume remote code execution in ax-api.

Attacker must not obtain:
- Core DB credential;
- Core Redis credential;
- Core session secret;
- Core internal token;
- user seed phrase/private key;
- migration superuser;
- unrestricted RPC/internal-network access.

Residual capabilities must be documented.

## 27. Compromised watcher scenario

Assume watcher compromised.

Attacker may submit false observations.

Controls:
- independent observation sources;
- observation provenance;
- settlement confidence policy;
- no watcher authority to accept trades or change policy.

## 28. Compromised admin session scenario

Assume browser admin session stolen.

Controls:
- fresh WebAuthn/passkey challenge for critical actions;
- WYSIWYS confirmation;
- challenge bound to configuration hash;
- short privileged session;
- immutable audit;
- optional second approver for selected production actions.

## 29. Privilege escalation review

For every service, ask:
- What can this identity read?
- What can it write?
- What can it delete?
- What can it call?
- What network can it reach?
- Which secrets can it obtain?
- Can compromise cross into another zone?
- Can it disable recovery?
- Can it touch Core?

Any unnecessary capability is removed before implementation.

## 30. Recovery non-disable invariant

No generic flag may disable:
- redeem;
- refund;
- recovery.

Emergency controls must separate:
- new offers;
- new trades;
- new locking;
from:
- redeem;
- refund;
- recovery.

## 31. Incident isolation procedure

If one Asset Exchange service is compromised:

1. stop new offers/trades as required;
2. increment/activate incident policy epoch where applicable;
3. preserve recovery;
4. revoke compromised service identity;
5. isolate network path;
6. rotate only affected Asset Exchange credentials;
7. verify Core credentials were inaccessible;
8. validate chain state;
9. rebuild service from trusted artifact;
10. document incident and residual risk.

Core shutdown is not the default response to Asset Exchange compromise.

## 32. Quarantine procedure

A chain/asset incident should allow:

- marketplace visibility optional;
- newOffers=false;
- newTrades=false;
- newLock=false;
- existing settlement according to protocol safety;
- redeem=true where valid;
- refund=true where valid;
- recovery=true.

Quarantine must be granular by chain/asset/protocol.

## 33. Security review checklist before implementation

Before provisioning any G0 infrastructure:

- [ ] current main HEAD verified;
- [ ] branch compared with main;
- [ ] no concurrent Core file conflict;
- [ ] all service identities documented;
- [ ] network matrix reviewed;
- [ ] secret matrix reviewed;
- [ ] DB roles reviewed;
- [ ] restore target guard designed;
- [ ] negative tests specified;
- [ ] Core denial tests specified;
- [ ] recovery availability checked;
- [ ] CI permissions reviewed.

## 34. G0 PASS criteria

G0 may pass only when evidence demonstrates:

1. dedicated Exchange DB exists;
2. dedicated Exchange Redis exists;
3. dedicated Exchange secret namespace exists;
4. dedicated runtime/deploy identities exist;
5. Exchange identities cannot reach Core DB/Redis/secrets;
6. Core functionality survives complete Exchange outage;
7. Redis loss does not alter financial truth;
8. RPC SSRF controls are proven by negative tests;
9. backup restore cannot target Core;
10. recovery is independent from new-trade kill switches;
11. CI/deploy compromise is compartmentalized;
12. evidence is recorded and reviewed.

## 35. Current status

Design: COMPLETE FOR FIRST G0 REVIEW PASS.
Infrastructure provisioning: NOT STARTED.
Tests executed: NOT YET.
G0 status: BLOCKED pending implementation evidence.

This is the correct state. A document alone is not evidence that controls work.
