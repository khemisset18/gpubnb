# gpu.k.p2p — G1 Application Security Architecture v0

Status: G1 WORKING DRAFT / PRE-DEVELOPMENT / NO REAL FUNDS

## 1. Purpose

This document defines the application-security controls required before gpu.k.p2p can move from
security architecture into executable marketplace implementation.

Scope:
- authentication and sessions;
- authorization / BOLA-IDOR;
- API abuse and business-flow abuse;
- WebSocket security;
- browser/XSS/CSP/CSRF;
- RPC/SSRF isolation;
- admin security;
- privacy / data retention;
- audit and logging;
- third-party API consumption;
- KYC boundary integration;
- negative/adversarial tests.

No Mainnet settlement is authorized by this document.

## 2. Core security invariants

1. Every object access is authorized server-side.
2. Every privileged function is authorized server-side.
3. Client-visible IDs never imply access rights.
4. Exchange authentication is independent from GPUbnb Core authorization.
5. KYC/Compliance status is Exchange-only and never a Core account gate.
6. Redis, browser state and WebSocket state are never financial truth.
7. User chat text never mutates signed trade terms.
8. No API may cause an asset lock without current policy, state, protocol and recovery validation.
9. New activity can be stopped without disabling redeem/refund/recovery.
10. All high-risk admin actions require fresh, phishing-resistant reauthentication.
11. RPC destinations are never blindly fetched from user/operator-supplied URLs.
12. Logs are useful for incident response but never contain secrets.

## 3. Authentication boundary

gpu.k.p2p owns its own session.

Optional GPUbnb Core bridge:
Core -> short-lived signed identity ticket -> Exchange verifies -> Exchange creates local session.

Required ticket checks:
- issuer;
- audience;
- expiry;
- issued-at;
- jti/nonce;
- signature algorithm;
- key identifier;
- protocol version;
- replay state.

The Exchange session must remain invalidatable independently from Core.

Forbidden:
- sharing Core SESSION_SECRET;
- sharing Core cookies;
- treating a Core wallet field as Exchange identity;
- KYC claims in Core session;
- trusting a ticket without audience validation.

## 4. Session security

Preferred browser session:
- Secure cookie;
- HttpOnly;
- SameSite appropriate to architecture;
- narrow Path/Domain;
- rotation after login / privilege escalation;
- bounded absolute lifetime;
- inactivity timeout where appropriate;
- server-side revocation support;
- CSRF defense for cookie-authenticated state changes.

Sensitive session events:
- login;
- logout;
- credential/passkey change;
- new wallet binding;
- admin elevation;
- recovery operation.

Session identifiers must never appear in URLs.

## 5. Reauthentication

Fresh reauthentication required for:
- admin policy changes;
- mode changes;
- chain enablement;
- asset quarantine reversal;
- RPC endpoint change;
- settlement protocol enablement;
- recovery override;
- wallet/account-security change;
- changing privileged identity settings.

Preferred admin method:
WebAuthn/FIDO2/passkey/hardware-backed authenticator.

A normal authenticated web session alone is insufficient for critical admin actions.

## 6. BOLA / IDOR

Every endpoint receiving an object identifier must verify:
- subject;
- tenant/deployment;
- role;
- relationship to object;
- object state;
- operation permission.

Sensitive objects include:
- offers;
- trades;
- settlement events;
- wallet bindings;
- recovery records;
- KYC/compliance records;
- admin policies;
- audit objects.

Never rely on:
- unguessable IDs alone;
- UUID secrecy;
- frontend route guards;
- ownership inferred from a client-provided user_id.

## 7. Object-property authorization

Responses and updates use explicit field allowlists.

Prevent:
- mass assignment;
- hidden field mutation;
- privilege escalation by JSON fields;
- changing maker/taker;
- changing signed amount/network/asset;
- setting internal risk flags;
- setting settlement status;
- overwriting audit fields.

Unknown critical fields must be rejected in signed/security-sensitive schemas.

## 8. Function-level authorization

Administrative and internal routes must not be reachable merely by knowing the URL.

Examples requiring explicit privilege checks:
- quarantineAsset;
- changeMode;
- updateRpc;
- enableSettlementProtocol;
- rotatePolicy;
- emergencyStopNewLocks;
- readComplianceRecord;
- exportAuditEvidence.

Internal service endpoints require service identity, not only network location.

## 9. Business-flow abuse

Rate limits must account for expensive business actions, not only HTTP requests.

Protect:
- offer creation;
- offer cancellation;
- offer acceptance;
- wallet ownership proofs;
- trade-room subscriptions;
- KYC initiation;
- quote/risk checks;
- recovery generation;
- RPC health probes.

Use:
- per-IP limits;
- per-account limits;
- per-device/session limits where appropriate;
- per-object limits;
- concurrency limits;
- cost-weighted budgets.

Avoid global rate limits that can block legitimate refund/recovery.

## 10. Offer acceptance race

Whole-fill V1 offers must be accepted atomically.

Required:
- PostgreSQL transaction;
- expected-state check;
- unique reservation/consumption constraint;
- idempotency key;
- deterministic outcome for accept/cancel race.

Redis cannot decide the winner.

## 11. API input validation

All API inputs:
- schema validated;
- length bounded;
- enum bounded;
- integer amounts only;
- canonical chain/network identifiers;
- normalized encodings;
- explicit content type;
- reject duplicate JSON keys for security-sensitive payloads where parser stack permits;
- reject unknown critical fields.

Never parse blockchain amounts as floating point.

## 12. API output minimization

Return only required fields.

Do not expose:
- internal risk notes;
- raw provider responses;
- private destination addresses before needed;
- KYC case data;
- auth secrets;
- internal service topology;
- stack traces.

Public offer responses must use explicit public-field schemas.

## 13. API versioning

Every security-sensitive API/protocol message carries explicit version.

Deprecated versions:
- documented;
- monitored;
- disabled on schedule;
- never silently interpreted as latest.

Do not accept ambiguous versionless signed payloads.

## 14. Error handling

Public errors:
- stable code;
- safe message;
- correlation ID.

Internal logs:
- diagnostic context;
- no secrets.

Do not disclose:
- SQL;
- file paths unnecessarily;
- service credentials;
- stack traces;
- internal addresses.

Authentication errors should avoid useful account enumeration where practical.

## 15. CSRF

For cookie-authenticated state-changing endpoints:
- SameSite cookie policy;
- anti-CSRF token where required;
- Origin/Referer checks as defense-in-depth;
- no state change via GET.

Critical actions additionally require explicit intent and fresh state validation.

CSRF protection does not replace authorization.

## 16. XSS

All user-controlled content is untrusted.

High-risk sources:
- asset names;
- token metadata;
- NFT metadata;
- SVG/images;
- usernames;
- trade chat;
- RPC/provider messages;
- blockchain memo fields.

Controls:
- framework auto-escaping;
- contextual encoding;
- HTML sanitization only when HTML is truly required;
- no dangerouslySetInnerHTML without dedicated review;
- no execution of remote SVG/script content;
- trusted image proxy or restrictive media handling where needed.

## 17. Content Security Policy

Settlement and admin pages target strict CSP.

Principles:
- script-src from controlled origins only;
- no unsafe-eval;
- avoid unsafe-inline via nonce/hash architecture;
- object-src 'none';
- base-uri restricted;
- frame-ancestors restricted;
- connect-src allowlist;
- form-action restricted;
- upgrade-insecure-requests where applicable.

Report violations to a sanitized endpoint.

## 18. Clickjacking

Sensitive pages:
- CSP frame-ancestors;
- X-Frame-Options as compatibility defense where useful.

Wallet/signing confirmation must not be embeddable by arbitrary origins.

## 19. WebSocket handshake

Trade-room WebSocket:
- TLS only;
- authenticate connection;
- validate Origin strictly;
- validate session freshness;
- map connection to explicit user/subject;
- enforce connection quotas.

Do not accept wildcard Origin.

## 20. WebSocket message authorization

Connection authentication does not imply permission for every message.

Each action checks:
- authenticated subject;
- trade relationship;
- action permission;
- current trade state;
- message schema;
- rate limit.

Chat cannot:
- change destination;
- alter amount;
- alter asset/network;
- mark settlement complete;
- authorize refund/redeem.

## 21. WebSocket resource controls

Controls:
- max frame/message size;
- bounded decompression;
- connection count;
- per-user message rate;
- idle timeout;
- heartbeat;
- backpressure;
- bounded queues.

Reject malformed and oversized payloads early.

## 22. WebSocket logout/session expiry

When session revoked/expired:
- close or deauthorize active sockets;
- prevent stale socket from continuing privileged actions.

Reconnect requires fresh authentication.

## 23. RPC / SSRF architecture

Only ax-rpc-gateway may perform general blockchain RPC egress.

Application services must not fetch arbitrary URLs supplied by:
- user;
- token metadata;
- admin UI;
- chain registry;
- webhook payload.

RPC gateway validation:
- allowed schemes;
- hostname syntax;
- DNS resolution;
- destination IP classification;
- redirect revalidation;
- port allowlist;
- timeout;
- body-size limits;
- method allowlist;
- header allowlist.

## 24. SSRF denied destinations

Always deny unless separately isolated and explicitly required:
- 127.0.0.0/8;
- ::1;
- link-local;
- RFC1918 private networks;
- cloud metadata;
- Core DB/Redis;
- Asset Exchange DB/Redis;
- admin endpoints;
- control planes;
- Unix socket bridges;
- localhost aliases.

DNS rebinding must be considered.

## 25. RPC provider trust

RPC/explorer response is untrusted data.

For critical chain decisions:
- source identity recorded;
- freshness checked;
- chain/network checked;
- consistency checked;
- independent corroboration where practical;
- disagreement causes safe pause of NEW irreversible actions.

One RPC provider cannot unilaterally define settlement truth.

## 26. Third-party API consumption

Treat third-party APIs as hostile.

Validate:
- TLS;
- hostname;
- schema;
- size;
- status code;
- semantic ranges;
- freshness;
- signatures where supported.

Never deserialize arbitrary provider data into privileged internal objects without mapping.

## 27. Webhooks

All webhooks:
- authenticated/signature verified;
- timestamp/freshness checked;
- replay-protected;
- idempotent;
- schema validated;
- environment-bound;
- rate limited.

Webhook events cannot directly authorize fund movement.

Examples:
- KYC provider;
- monitoring;
- future payment/compliance services.

## 28. Admin plane

Admin UI/API is a separate privilege surface.

Controls:
- strong auth;
- WebAuthn/FIDO2 preferred;
- fresh challenge;
- least privilege;
- role separation;
- short privileged session;
- no shared admin accounts;
- immutable audit;
- WYSIWYS confirmation.

## 29. Admin WYSIWYS

Critical confirmation displays:
- action;
- target deployment;
- current mode;
- target mode;
- chain/asset/protocol;
- active trade count;
- recovery impact;
- config hash;
- challenge expiry.

Challenge is cryptographically/session-bound to exact action/configuration.

Any change invalidates challenge.

## 30. Admin roles

Conceptual split:
- SECURITY_ADMIN;
- POLICY_ADMIN;
- OPERATIONS_ADMIN;
- AUDITOR;
- SUPPORT_READONLY;
- RELEASE_OPERATOR.

No single routine support role receives:
- KYC export;
- settlement override;
- secret access;
- release signing.

High-risk actions may require dual approval later.

## 31. Kill switches

Fine-grained controls:
- disable new offers;
- disable new acceptances;
- disable new locks;
- quarantine asset;
- quarantine chain;
- quarantine protocol;
- freeze specific RPC provider.

Never implement one global switch that disables:
- redeem;
- refund;
- recovery.

## 32. KYC/compliance boundary

Follow KYC_AND_COMPLIANCE_ISOLATION.md.

Two commercial modes remain:
- CONFORMITE;
- SOUVERAIN.

Exchange KYC status never mutates:
- Core login;
- mining eligibility;
- GPU rental eligibility;
- machine/workspace entitlement.

SOUVERAIN does not mean legally exempt; it means the software does not impose a universal KYC rule
and the operator applies its own applicable policy.

## 33. Privacy data classes

P0 — prohibited server data:
- seed;
- raw private key;
- wallet password.

P1 — highly sensitive:
- session tokens;
- recovery secrets;
- KYC identifiers/documents if retained;
- unpublished wallet addresses;
- admin auth artifacts.

P2 — sensitive:
- trade history;
- signed terms;
- ownership proofs;
- risk decisions;
- IP/security telemetry.

P3 — public/intended-public:
- public offer fields;
- public asset registry;
- public status notices.

## 34. Data minimization

Every stored field requires:
- purpose;
- owner;
- retention;
- access role;
- deletion/archival behavior.

Avoid building one universal user profile correlating:
identity + IP + mining + rental + wallets + trades + KYC.

## 35. Retention model

Retention must be explicit per data class.

Rules:
- ephemeral security data: short retention unless incident hold;
- application logs: bounded;
- KYC data: only what applicable policy/legal review requires;
- audit evidence: durable according to governance;
- recovery material: protocol-specific minimum duration.

No "keep forever by default".

## 36. Deletion

Deletion workflow must distinguish:
- user-facing deletion request;
- legally required retention;
- security incident hold;
- immutable financial/audit evidence;
- blockchain-public data that cannot be deleted from chain.

Do not promise deletion of public blockchain history.

## 37. Logging

Use structured event schemas.

Log security-relevant events:
- login/logout;
- auth failure;
- authorization denial;
- admin action;
- policy change;
- mode epoch change;
- offer accept/cancel race;
- settlement transition;
- watcher disagreement;
- RPC failover;
- refund/recovery invocation.

Never log:
- seed/private key;
- raw password;
- bearer/session token;
- KYC document image;
- raw sensitive recovery secret.

## 38. Log injection

Sanitize/structure untrusted log fields.

Avoid raw newline-delimited concatenation.

Bound field sizes.

Log viewers treat data as text, not HTML.

## 39. Audit trail

Critical audit events should be:
- append-only/tamper-evident where practical;
- timestamped;
- actor identified;
- action identified;
- target identified;
- before/after hash where appropriate;
- correlation ID;
- source environment.

Audit records do not include unnecessary secrets.

## 40. Security telemetry

Alert candidates:
- repeated BOLA denials;
- unusual offer creation;
- brute-force auth;
- WebSocket origin failures;
- admin reauth failures;
- RPC SSRF attempts;
- chain-source disagreement;
- stale epoch activity;
- repeated idempotency collisions;
- recovery failure.

Alerts must avoid leaking sensitive payloads.

## 41. Support tooling

Support agents receive least privilege.

Support UI:
- masks sensitive values;
- no secret export;
- no KYC document access by default;
- no settlement override;
- audited impersonation if ever introduced.

Do not add hidden "god mode".

## 42. File/media handling

For uploaded or remote media:
- validate MIME and magic bytes;
- size limit;
- image decode in isolated library/process where practical;
- no active SVG by default;
- no executable uploads;
- random server-generated names;
- storage outside executable paths.

NFT/token metadata must not become active HTML.

## 43. Clipboard safety

Addresses:
- validate network/encoding;
- show strong visual distinction;
- do not silently replace;
- transaction intent must match signed terms.

Clipboard is convenience only, never authority.

## 44. Redirects

No arbitrary open redirects.

Wallet/provider callback routes:
- explicit allowlist;
- state binding;
- nonce;
- exact redirect URI matching where protocol supports it.

## 45. CORS

Default deny cross-origin.

Explicit allowlist for required production origins.

Never use wildcard with credentials.

Local wallet-agent CORS is separately restricted by WINDOWS_SECURITY_BASELINE.md.

## 46. HTTP security headers

Target:
- HSTS after deployment/domain validation;
- CSP;
- X-Content-Type-Options: nosniff;
- Referrer-Policy;
- Permissions-Policy;
- frame restrictions;
- secure cache policies on sensitive pages.

Do not cache private trade/admin responses in shared caches.

## 47. Caching

Cache keys must include authorization-relevant dimensions.

Private response:
- no-store where appropriate.

Never cache:
- admin challenge;
- KYC record;
- recovery secret;
- session-bearing page
in a shared public cache.

## 48. Idempotency

Fund-relevant mutation endpoints require idempotency.

Key bound to:
- subject/service identity;
- operation;
- trade;
- protocol version;
- expected state.

Same key with different body => reject.

## 49. Replay protection

Security-sensitive operations bind:
- nonce;
- expiry;
- domain;
- network;
- trade ID;
- version;
- session/identity where applicable.

Consumed signatures/acceptances cannot be reused in another trade or environment.

## 50. Environment separation

Dev/staging/prod:
- separate session secrets;
- separate WebAuthn RP/origin config;
- separate KYC vendor environment;
- separate DB/Redis;
- separate RPC credentials;
- separate admin identities where practical.

A staging token must never authenticate to production.

## 51. Feature flags

Feature flags cannot:
- authorize Mainnet;
- bypass signatures;
- weaken KYC policy silently;
- disable refund/recovery;
- bypass admin strong auth.

Safety-critical changes need versioned configuration and audit.

## 52. Configuration validation

On startup:
- validate environment;
- chain IDs;
- allowed origins;
- DB sentinel;
- Redis namespace;
- RPC allowlist;
- mode/config epoch;
- Mainnet lock state.

Fail closed for unsafe configuration.

## 53. Dependency on clock

Use monotonic clocks for local durations where possible.

Security decisions involving wall-clock time:
- allow bounded skew;
- monitor NTP;
- verify chain time/height semantics separately.

Do not derive blockchain timelocks from one unreliable local clock alone.

## 54. API inventory

Maintain canonical inventory:
- endpoint;
- method;
- version;
- auth mode;
- authorization rule;
- rate-limit class;
- data classification;
- owner;
- deprecation status.

Unknown/unowned endpoints are release blockers.

## 55. Sensitive endpoint inventory

Dedicated list for:
- settlement;
- recovery;
- admin;
- wallet binding;
- KYC;
- RPC configuration;
- release/config controls.

Security tests target every endpoint in this list.

## 56. Required negative tests — authorization

For every object type:
- owner allowed;
- unrelated user denied;
- same role/different object denied;
- guessed/sequential/random ID denied;
- cross-deployment denied;
- deleted/expired state handled safely.

For every admin function:
- anonymous denied;
- normal user denied;
- wrong admin role denied;
- stale elevated session denied.

## 57. Required negative tests — authentication

- replay SSO ticket;
- wrong audience;
- wrong issuer;
- expired ticket;
- future issued-at beyond skew;
- unknown key id;
- session fixation;
- revoked session;
- stale passkey challenge.

## 58. Required negative tests — browser

- reflected XSS;
- stored XSS in chat/metadata;
- SVG script payload;
- CSP bypass attempts;
- clickjacking;
- CSRF;
- open redirect;
- CORS credential misuse;
- cache leakage.

## 59. Required negative tests — WebSocket

- unauthorized Origin;
- unauthenticated connect;
- expired session;
- access another user's trade;
- oversized message;
- flood;
- malformed JSON;
- injection payload;
- unauthorized admin-like action;
- logout then reuse open socket.

## 60. Required negative tests — SSRF

Attempt:
- localhost;
- IPv6 loopback;
- decimal/hex IP tricks;
- DNS rebinding;
- metadata endpoints;
- redirects to private IP;
- userinfo URL tricks;
- alternate schemes;
- Core DB/Redis;
- Exchange DB/Redis;
- admin/control plane.

Expected: denied before useful connection.

## 61. Required negative tests — logs/privacy

Inject secrets and synthetic KYC material into all error paths.

Verify:
- redacted;
- not in analytics;
- not in traces;
- not in client error responses;
- not in support export.

## 62. Required negative tests — recovery

During:
- KYC outage;
- policy outage;
- API outage;
- Redis outage;
- asset quarantine;
- mode transition;
- admin lockout;

verify available protocol-safe refund/redeem/recovery paths are not disabled.

## 63. Security gates

G1 can pass only when:
- component threat register reviewed;
- API inventory complete;
- authorization matrix specified;
- admin model specified;
- privacy inventory specified;
- SSRF/RPC controls specified;
- logging redaction specified;
- KYC isolation tested by design review;
- negative test plan complete.

Implementation evidence comes later in G5+.

## 64. Coding rules for future implementation

- central authorization primitives, not scattered ad-hoc checks;
- typed validated schemas;
- explicit integer amount types;
- no generic "admin=true" shortcuts;
- no unrestricted fetch() to user-supplied URLs;
- no silent error fallback to allow;
- no swallowing security validation failures;
- no private-key handling server-side;
- no security decisions based solely on frontend state.

## 65. Independent review

Before real settlement:
- API security review;
- auth/session review;
- WebSocket review;
- SSRF review;
- privacy review;
- admin privilege review;
- fuzzing;
- external penetration test.

## 66. Current status

G1 architecture: DRAFTED.
Application implementation: NOT STARTED.
Negative tests: NOT EXECUTED.
Real funds: FORBIDDEN.
Mainnet: FORBIDDEN.

This document is a testable security contract, not proof of implementation.
