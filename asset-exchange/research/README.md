# Offline swap design research

Only pure data models, structural validators and digest-pinned source inspection.
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
