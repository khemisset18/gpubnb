# asset-exchange-settlement

Status: G6 REGTEST SECURITY FOUNDATION / NO MAINNET / NO REAL FUNDS.

This module contains reviewed settlement primitives and test-only Bitcoin V1 foundations.

Implemented foundations:
- exact Bitcoin P2WSH HTLC builder;
- signed Bitcoin settlement terms;
- explicit timeout/confirmation derivation with stale-term rejection;
- external signer intent validation;
- regtest-only security tests.

Not authorized:
- production/Mainnet settlement;
- server-side wallet signing;
- implicit production timeout defaults;
- arbitrary chain adapters;
- HTTP settlement broadcast routes.

Real transaction execution remains confined to the isolated Bitcoin Core regtest harness until later gates pass.
