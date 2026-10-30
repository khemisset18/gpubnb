# Offline swap design research

Offline data models, structural validators, local POSIX persistence and
digest-pinned source inspection.
No node/signer/wallet/transaction executor, production import or capability
activation. The model accepts assumed validator outputs; it does not implement
cryptographic verification or establish D2–D9 qualification.

Run all tests with Node 22: `npm --prefix asset-exchange test`.
The BasicSwap routing inspection requires a local exact source checkout:
`python3 asset-exchange/research/tools/probe-basicswap-routing.py /path/to/basicswap`.
It checks source digests before evaluating only the pinned pure routing methods;
it imports no upstream application and performs no network or blockchain call.

The reviewed source ledger, twenty-direction pair matrix, architecture,
recovery/threat/fee/state/authorization and license/legal notes are under
`docs/asset-exchange/research/2026-10-29/`. All production-facing capabilities
remain unchanged. No external implementation was vendored into the runtime.

## Durable offline protocol specification

`src/offline-protocol.mjs` replays strict public events with separate observed and
confirmed locks, sticky exposure, stale/conflicting evidence holds and reorg
reconciliation. `src/offline-protocol-store.mjs` persists and replays that model
through the private POSIX journal with compare-and-swap, idempotency and an
independently retained checkpoint. Every result remains unqualified with no
executable operations. Neither module is imported into financial runtime paths.
See `docs/asset-exchange/research/2026-10-30/DOGE_OFFLINE_INCREMENT_C.md` for the
actual filesystem/process tests and the distinction from native recovery proofs.
