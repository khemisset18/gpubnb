# GPUbnb Asset Exchange — Secure Foundation v1

Status: PRE-DEVELOPMENT / NO REAL FUNDS

## Purpose

This branch contains the isolated foundation for the future GPUbnb Asset Exchange.
The user-facing product is branded "gpu.k.p2p", while the technical subsystem remains named
`asset-exchange` to avoid confusion with GPUbnb's existing QUIC/serverless P2P data plane.

## Non-negotiable isolation invariants

1. GPU rental, mining, machines, workspaces and core accounts MUST continue to operate when
   the entire Asset Exchange is unavailable, disabled, deleted or under incident response.
2. Asset Exchange MUST NOT share the core GPUbnb PostgreSQL database.
3. Asset Exchange MUST NOT share the core GPUbnb Redis instance as a financial source of truth.
4. Asset Exchange MUST NOT require imports into the existing core API settlement/mining runtime.
5. Asset Exchange MUST NOT receive core GPUbnb secrets unless a narrowly scoped, documented bridge
   is explicitly approved.
6. Core GPUbnb MUST NOT depend on Asset Exchange for rental, mining, machine control, workspace
   access or account authentication.
7. The only intended product-level integrations are:
   - navigation / routing;
   - an optional short-lived signed identity bridge;
   - branding/design consistency.
8. Asset Exchange failures MUST have zero availability impact on core GPUbnb.
9. Asset Exchange migrations MUST never target the core GPUbnb database.
10. Real-funds settlement is forbidden until the relevant protocol passes all security gates.

## Security invariants

- Never request, transmit or store user seed phrases or raw private keys.
- Never use floating point for blockchain amounts.
- Never identify an asset by symbol/logo alone.
- Never mutate trade-critical terms after both parties sign.
- Never rely on a single RPC/explorer as the sole source of truth for fund-critical decisions.
- Never disable redeem/refund/recovery because of maintenance, feature flags or mode switching.
- Never introduce new cryptography without independent expert review.
- Never claim atomic/secure settlement where the chain adapter cannot prove the required guarantees.
- Every financial operation must be idempotent, replay-aware and recoverable after process failure.
- Every chain can be independently restricted or quarantined without affecting other chains.

## Deployment modes

### Conformité

Policy-driven deployment intended for regulated/enterprise operation. Compliance modules are
separate from settlement cryptography.

### Souverain

Self-hosted/operator-controlled deployment. The operator controls infrastructure and policy.
This mode does not weaken cryptographic safety requirements and must not be marketed as a
guarantee of being outside applicable law.

### Mode transition

Transitions use a dedicated TRANSITION state and a monotonic mode epoch/fencing token.
New trades stop before drain begins. Existing settlement, redeem, refund and recovery remain
available until all unsafe in-flight states are resolved.

## Required documents before real settlement implementation

- THREAT_MODEL.md
- PROTOCOL_RFC_V1.md
- CHAIN_CAPABILITY_MATRIX.md
- ASSET_RISK_MODEL.md
- LICENSE_MATRIX.md
- RECOVERY_SPEC.md
- MODE_TRANSITION_SPEC.md
- DATA_FLOW_AND_TRUST_BOUNDARIES.md
- SECURITY_GATES.md

## First implementation rule

The first executable Asset Exchange code must be infrastructure/marketplace-only and incapable
of moving real funds. The first settlement engine starts on regtest/testnet only after protocol
and recovery specifications are reviewed.
