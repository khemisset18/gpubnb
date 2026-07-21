# Mainnet hardening applied

- Canonical escrow PDA constraints added to settlement, dispute, finalization, resolution and refund instructions.
- Settlement proposals are blocked while the program is paused.
- Boundary and overflow-oriented Rust unit tests added.
- Production authentication domain is fixed by configuration instead of trusting the HTTP Host header.
- Mainnet requires `finalized` commitment and rejects the public Solana RPC endpoint.
- Deposit construction and verification use the configured commitment.
- Booking creation rejects stale dates, dates beyond 30 days and zero-value quotations.
- Agent heartbeat counters use safe integer bounds and BigInt comparison.
- Claimed workload sessions must belong to the same machine and an active booking window.
- Production agents require HTTPS and validate private-key length.
- Secret/key files are excluded by `.gitignore`.
- CI now includes Rust tests and static production-gate checks.

These changes do not replace an independent audit, multisig deployment, workload sandbox implementation, penetration test, private RPC, production backups or legal review.
