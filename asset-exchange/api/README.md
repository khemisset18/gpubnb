# asset-exchange-api

Status: G5 non-financial shell.

Implemented:
- explicit Asset Exchange configuration boundary;
- no fallback to Core DATABASE_URL / REDIS_URL;
- loopback bind by default;
- wildcard CORS rejected;
- GET /healthz;
- GET /readyz;
- generic errors without readiness exception leakage;
- no business routes.

Future responsibilities:
- Exchange-only authentication/session;
- signed offer/accept/cancel APIs;
- per-object authorization;
- fee-policy read endpoints;
- optional signed Core SSO ticket verification.

Forbidden:
- Core DB models;
- Core Redis;
- private-key custody;
- direct settlement broadcasting.

No offer/trade/settlement/admin endpoint is enabled in this slice.
