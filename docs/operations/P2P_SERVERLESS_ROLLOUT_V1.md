# P2P / Serverless rollout v1

## Release rule

Do not route production GPU session payloads through the control Gateway. Keep the Gateway as the fenced command/presence channel and move session traffic to Host/Renter direct QUIC.

## Phase 0 - contract

- ship the signed rendezvous ticket contract;
- keep ticket TTL at or below 120 seconds;
- bind every ticket to the current lease and fencing token;
- keep candidate lists bounded at 12 per peer;
- enforce `HOST -> SERVER_REFLEXIVE -> RELAY` attempt order;
- keep relay `FALLBACK_ONLY` by default.

## Phase 1 - Agent candidate gathering

The Host Agent and Renter client gather interface candidates and public UDP mappings. Candidate publication must contain no account/profile/payment data. Do not publish arbitrary local filesystem information.

A control-plane rendezvous response returns only the signed short-lived ticket needed to authenticate the peers and attempt connectivity.

## Phase 2 - direct QUIC canary

Enable direct session establishment progressively: `0.1% -> 1% -> 5% -> 25% -> 50% -> 100%`.

For every attempt record only operational counters needed for qualification: candidate class, success/failure code, connection latency, reconnect result and whether fallback was required. Keep product PII out of hot-path telemetry.

Promotion requires no cross-lease connection, no stale fencing acceptance, no replay acceptance, and no regression in rental stop/revoke behavior.

## Phase 3 - relay fallback

Introduce relay capacity only for peers that fail direct attempts. The relay must:

- be selected after HOST and SERVER_REFLEXIVE attempts;
- carry encrypted session traffic without becoming rental authority;
- be revocable by the same lease/fencing lifecycle;
- have explicit bandwidth and concurrency budgets;
- expose the fallback rate so cost is measurable.

## Qualification before a production claim

Test at minimum home NAT, CGNAT, symmetric NAT, IPv6-only/dual-stack, restrictive firewall, packet loss, endpoint change, Host reconnect, rental revocation during connection establishment, and relay loss.

The first useful product metric is not `1M modeled`; it is the measured percentage of real rentals whose heavy data path stayed directly between Renter and Host.
