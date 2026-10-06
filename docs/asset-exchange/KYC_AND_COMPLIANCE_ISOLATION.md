# gpu.k.p2p — KYC and Compliance Isolation Contract v0

Status: SECURITY ARCHITECTURE / DRAFT / NO REAL FUNDS

## 1. Non-negotiable product decision

KYC/AML/Travel Rule, where applicable to an Asset Exchange deployment, belong **exclusively to gpu.k.p2p (asset-exchange)**.

KYC for gpu.k.p2p MUST NOT become a requirement to use:
- GPUbnb mining;
- GPU rental;
- machine management;
- workspaces;
- agents;
- GPUbnb Core account login;
- the existing QUIC P2P networking services.

This document does not assess whether separate legal obligations apply independently to GPUbnb Core services. It prohibits imposing the Asset Exchange KYC workflow on those services through technical coupling.

## 2. Separation of policy

Core authorization = Core policies only.

Asset Exchange authorization = Asset Exchange policies only.

An Asset Exchange KYC failure, suspension, rejection, incomplete application, expired review or third-party KYC outage MUST NOT change Core entitlement or Core account status.

Asset Exchange policy may block new Asset Exchange activity when required. It must not block permissible redeem/refund/recovery of existing commitments merely because the identity provider fails or policy changes.

## 3. Separate identity boundary

Core may optionally issue a short-lived signed SSO identity ticket containing an opaque subject and minimum authentication claims.

Asset Exchange verifies the ticket and creates its own session.

Forbidden:
- adding KYC data to Core User.wallet;
- adding KYC status to Core's generic login allow/deny condition;
- using Core account suspended/disabled as a side effect of an Asset Exchange KYC decision;
- requiring a KYC vendor call for mining/rental requests;
- sharing KYC provider credentials with Core;
- setting a common cookie that carries KYC status across products.

The SSO bridge authenticates an identity; it does not grant trading permission.

## 4. Distinct KYC storage

Prefer separate physical storage or separately controlled, independently encrypted KYC data environment within the Exchange security domain.

At minimum:
- distinct database/credentials/roles from Core;
- narrow compliance-service access;
- no Core DB joins;
- no automatic account enrichment of mining/rental profiles;
- no copies of document images into general trade, offer, logs or audit stores;
- no unredacted KYC material in observability;
- encryption in transit and at rest;
- narrowly scoped KMS/secrets;
- deletion and retention controls tied to applicable obligations.

For most workflows consider a third-party provider-hosted verification process, where the Exchange receives only the minimum decision/status and references necessary for permitted compliance tasks.

Do not claim zero retention where mandatory retention applies.

## 5. Minimal exchange policy decision

Conceptual, versioned decision:

ExchangeEligibility {
  exchange_subject_id
  jurisdiction_policy_id
  policy_version
  kyc_status
  sanctions_status
  eligibility_decision
  reviewed_at
  expires_at
  reason_codes_minimal
}

Allowed decisions include ALLOW, DENY, REVIEW and NOT_REQUIRED.

NOT_REQUIRED is a policy result for a given deployment, not a global statement of legal exemption.

Do not attach passport scans, selfies, source-of-funds documents or full provider responses to ordinary Exchange session claims.

## 6. Two commercial modes

### CONFORMITE (Mode Conformité Europe)

The Exchange-only policy engine activates controls required by the legally reviewed deployment profile, potentially including KYC, AML, sanctions and other applicable workflows.

No change to mining, rental or Core user journeys.

### SOUVERAIN (Mode Souverain)

The Exchange operator selects the policy applicable to their own deployment and jurisdiction, including whether specific identity workflows are required.

SOUVERAIN is not a guarantee of no law, no KYC or no compliance obligations.

Both modes preserve identical non-custodial, cryptographic locking, refund, recovery and Core-isolation requirements.

### TRANSITION

Admin mode changes use strong reauthentication, monotonic epoch fencing and safe draining.

No new exchange exposure during transition; existing recovery paths remain available.

No Core policy change.

## 7. Product UX

Mining and GPU rental show no gpu.k.p2p KYC prompt or badge.

In gpu.k.p2p:
- show KYC requirements only when the active Exchange policy requires it;
- explain simply why verification is needed and who processes the data;
- avoid requesting the same data repeatedly when a valid assessment may legally be reused within the Exchange;
- never show KYC documents to counterparties;
- never reveal KYC status publicly in offers or chat;
- never treat identity verification as proof that a trade is safe.

An Exchange user who has not completed required KYC can continue using Core capabilities governed by Core's independent requirements.

## 8. Third-party identity providers

If integrated, the vendor is accessible only to the Exchange compliance boundary.

Controls:
- vendor-specific credentials limited to compliance services;
- signed and authenticated webhook verification;
- replay protection;
- idempotent updates;
- least-data API scopes;
- vendor outage fail-closed for new Exchange eligibility decisions when required;
- no vendor on Core critical paths;
- deletion/retention and international transfer review;
- vendor incident, termination and data export procedures;
- periodic access/audit review.

Vendor webhooks never authorize funds movement, asset locks, refunds or signed terms directly.

## 9. Forbidden data propagation

Never propagate from Exchange to Core:
- KYC required/pending/approved/rejected flags;
- passport/ID images;
- biometric/liveness artefacts;
- sanctions screening reports;
- source-of-funds documents;
- provider case IDs unless separately justified for a specific legal requirement;
- AML risk score;
- detailed exchange trade and wallet history as routine Core user attributes.

A limited security incident response may require controlled, independently justified information exchange; it is not the default integration and requires legal/security review.

## 10. Threats and controls

### KYC-ISO-001 — KYC outage blocks mining/rental
Severity: CRITICAL (cross-product availability breach).
Prevention: zero Core dependency on Exchange KYC, dedicated vendor call path.
Test: disable provider and Exchange; verify Core mining/rental/login.

### KYC-ISO-002 — KYC rejection disables Core account
Severity: CRITICAL (cross-product authorization breach).
Prevention: separate policy engine and entitlements; no Core account mutation.
Test: force KYC DENY; verify Core entitlements unchanged.

### KYC-PRIV-001 — ID documents leak into Core/logs
Severity: HIGH.
Prevention: no Core KYC fields, storage isolation, field allowlists, redaction.
Test: synthetic KYC artefact tracing through DB/log/event pipelines.

### KYC-PRIV-002 — Trade peers see sensitive verification material
Severity: HIGH.
Prevention: private compliance enclave; public offer schema allowlist.
Test: peer/API object authorization and metadata exfiltration tests.

### KYC-AUTH-001 — Spoofed verification webhook
Severity: HIGH.
Prevention: vendor signature verification, expiry/replay rules, authenticated delivery, idempotency.
Test: unsigned, replayed, cross-environment and stale webhooks rejected.

### KYC-OPS-001 — Vendor outage falsely grants trading
Severity: HIGH/CRITICAL according to policy.
Prevention: fail closed for new trade eligibility where required, versioned decisions.
Test: vendor unavailable and uncertain state; ensure no unauthorized new lock.

### KYC-REC-001 — Expired KYC disables refund
Severity: CRITICAL.
Prevention: separate eligibility for NEW activity from existing recovery actions.
Test: expire KYC mid-trade; confirm redeem/refund/recovery rights remain available where safe and legally permissible.

### KYC-SSO-001 — KYC claims injected into shared Core session
Severity: HIGH.
Prevention: independent Exchange session and minimal SSO claims.
Test: verify no KYC field/cookie present in Core login or authorization.

## 11. Mandatory negative tests

Before G0/G1 pass:
1. KYC provider unavailable -> Core login works.
2. Exchange unavailable -> GPU rental/mining/machines/workspaces work.
3. KYC rejected -> Core account not blocked.
4. KYC pending -> Core rental/mining unaffected.
5. Exchange compliance DB lost -> Core DB and login unaffected.
6. Core service identity denied KYC database and secrets.
7. Exchange KYC identity denied Core database, Redis and secrets.
8. Provider webhook replay rejected.
9. KYC document absent from public offer/trade/chat/API and logs.
10. Mode CONFORMITE <-> SOUVERAIN changes only Exchange policy, never Core authorization.
11. Expired KYC cannot silently remove existing protocol refund/recovery rights.
12. New Exchange trade eligibility is evaluated against active versioned jurisdiction policy.

## 12. Release acceptance

Design documented: YES.
Implementation: NOT STARTED.
Negative tests executed: NO.
G0/G1 security acceptance: BLOCKED until evidence exists.

This specification is an architectural boundary, not evidence of live enforcement.

## 13. Source of product authority

The project owner's explicit requirement: KYC, if needed, applies solely to the new gpu.k.p2p
Asset Exchange. GPU mining and GPU rental remain separately operated and must not inherit its
KYC requirements.

Any future proposal to change this separation must undergo explicit owner approval, security review
and independent legal assessment. Never change it as a convenience refactor.
