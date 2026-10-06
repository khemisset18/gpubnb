# gpu.k.p2p Asset Exchange

Status: G5 FOUNDATION / NO REAL FUNDS / NO MAINNET

This subtree is intentionally isolated from GPUbnb Core.

## Invariants
- no import from `apps/api`, Core Prisma schema, Core Redis helpers or Core auth state;
- no shared database credentials;
- no shared Redis credentials;
- no seed/private-key custody;
- no chain broadcast in this foundation;
- integer atomic amounts only;
- signed terms and policy epochs are immutable security inputs.

## Layout
- `core/` — zero-runtime-dependency financial/domain primitives;
- `api/` — future Exchange-only API boundary;
- `worker/` — future durable commands/jobs;
- `chain-watchers/` — future untrusted chain evidence adapters;
- `recovery/` — future independent recovery tooling;
- `settlement/` — future chain-family settlement implementations;
- `web/` — future user interface;
- `wallet-agent/` — future local signer bridge.

The first G5 slice deliberately implements only pure primitives and tests.
