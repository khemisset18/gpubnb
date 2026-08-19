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

### Agent configuration and safety bounds

STUN is disabled when `stunServers` is empty. Operators must provide an explicit
list; the Agent contains no public default. The configuration object passed to
candidate discovery has this shape:

```json
{
  "stunServers": [{"host": "stun.region.internal", "port": 3478}],
  "stunTimeoutMs": 1000,
  "stunTotalTimeoutMs": 4000
}
```

Hard bounds are four STUN servers, 3 seconds per server, 8 seconds total, 1200
bytes per response and 12 candidates per peer. Invalid configuration fails closed.
Individual unreachable or malformed STUN responses are ignored so HOST discovery
can proceed; no endpoint is included in the resulting stable error code.

The returned discovery object owns a bound UDP socket. Keep it alive until direct
QUIC either adopts it or is abandoned. Closing it and binding another socket can
change the NAT mapping and invalidates the server-reflexive candidate.

### Operator checks and rollback

Before enabling candidate publication:

1. verify UDP egress and DNS resolution to each configured STUN service;
2. run `python -m pytest -q agent/tests/test_p2p_connectivity.py`;
3. confirm heartbeats and general telemetry contain neither `hostCandidates` nor
   `renterCandidates`, `endpoint`, or discovered public addresses;
4. confirm the existing `gpubnb-host-tunnel` process still starts normally.

Roll back by disabling candidate publication or supplying an empty `stunServers`
list. Do not remove or bypass ticket verification, fencing, TTL limits or the Edge
tunnel. Candidate Discovery v1 alone does not alter the active data path.

## Phase 2 - direct QUIC canary

Enable direct session establishment progressively: `0.1% -> 1% -> 5% -> 25% -> 50% -> 100%`.

For every attempt record only operational counters needed for qualification: candidate class, success/failure code, connection latency, reconnect result and whether fallback was required. Keep product PII out of hot-path telemetry.

Promotion requires no cross-lease connection, no stale fencing acceptance, no replay acceptance, and no regression in rental stop/revoke behavior.

### Direct-session bounds and rollback

- require mutual TLS with an operator trust root and ALPN `gpubnb-p2p-direct/1`;
- allow at most eight direct attempts, five seconds per attempt and fifteen
  seconds overall;
- send at most three hole-punch hints to each signed direct candidate;
- accept only a `VerifiedRendezvousTicket`, never an unchecked JSON ticket;
- recheck expiry and current lease/fencing authority during the handshake;
- emit candidate class, outcome code, latency, attempt count, reconnect outcome
  and fallback-required only. Never emit an endpoint, IP, session or user ID.

Rollback by disabling the direct-session rollout flag. The existing
`gpubnb-host-tunnel` remains the fallback for `FALLBACK_ONLY` tickets. Do not turn
fallback on for `DIRECT_ONLY`, and do not extend ticket expiry to hide connection
failures.

### Real NAT-to-NAT qualification

The helper `agent/tools/p2p_direct_qualify.py` runs one peer per machine and prints
only non-sensitive JSON metrics. Each process first performs Candidate Discovery
and keeps its returned socket open. It writes candidates to an ACL-protected
exchange file, waits in the same process for the Control Plane (or a secured test
harness) to write the signed ticket, verifies it, and transfers that exact socket
object to QUIC. A pre-existing candidate or ticket file is rejected as stale.
Never pass private keys on the command line or commit exchange files.

1. Place machine A and machine B on genuinely different networks and confirm no
   shared LAN route exists.
2. Configure distinct `candidateOutputFile` and `ticketInputFile` paths under the
   `rendezvous` section for each peer. Both paths must be absent before startup.
3. Run the Host first:
   `python agent/tools/p2p_direct_qualify.py --config host-private.json`.
4. Publish the emitted private candidate file to the rendezvous issuer and write
   its returned signed ticket to `ticketInputFile` while the process remains
   alive. Repeat for the Renter on machine B.
5. Record only the emitted result (`DIRECT_HOST`,
   `DIRECT_SERVER_REFLEXIVE`, `TIMEOUT`, `AUTH_FAILED`, or fallback required),
   latency and attempt count.
6. Repeat across home NAT, CGNAT, symmetric NAT, IPv6-only/dual-stack,
   restrictive firewall, packet loss, endpoint change and fencing rotation.
7. Destroy the short-lived private configuration and exchange files and retain
   only aggregate non-sensitive results.

The helper never closes and rebinds a port after receiving the ticket. Socket
object identity and file descriptor are preserved from discovery, across ticket
wait/verification, through QUIC adoption. Ticket wait is bounded to 120 seconds;
failure is terminal and closes the reserved socket.

Do not report NAT-to-NAT success based on the CI loopback test. A production claim
requires recorded successful runs from two separate real networks.

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
