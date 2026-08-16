# GPUbnb P2P / Serverless Control Plane v1

## Goal

GPUbnb must make the Host and Renter machines carry the expensive data-plane work. The central platform coordinates authorization and discovery; it must not become the default proxy for GPU traffic, renter files, model payloads, or interactive session bandwidth.

This layer is stacked on the existing fenced Regional Connection Gateway. It does not remove the Gateway, Redis fencing, qualification work, or the production-scale lab. It changes the intended data path.

## Target data path

```text
                    lightweight GPUbnb control plane
                 auth / rental / lease / rendezvous ticket
                              |       |
                              v       v
                         Renter <----> Host Agent
                               direct QUIC
                                  |
                                  v
                                 GPU

Fallback only when direct connectivity fails:

                         Renter <----> Relay <----> Host
                                  end-to-end session
```

The relay is transport fallback, not rental authority. It must never be required for the common path and must not make GPUbnb the owner of the heavy data plane.

## Rendezvous contract

`services/control-gateway/src/p2p.rs` defines a bounded, signed rendezvous ticket. A ticket is bound to:

- one `sessionId`;
- one `machineId`;
- the current `leaseId` and exact `fencingToken`;
- short issue/expiry timestamps (hard maximum: 120 seconds);
- a replay nonce;
- ephemeral Host and Renter connection keys;
- bounded Host/Renter candidate sets;
- an explicit relay policy.

The control plane signs the complete ticket with Ed25519. Mutating the lease, fencing token, endpoint list, keys, expiry, nonce, or relay policy invalidates the signature.

The ticket intentionally contains no email, owner identity, payment/card/billing data, or renter filesystem metadata.

## Candidate order

The protocol has three candidate classes:

1. `HOST`: a directly reachable local/interface candidate;
2. `SERVER_REFLEXIVE`: a public UDP mapping learned by the Agent through a STUN-like discovery service;
3. `RELAY`: a last-resort encrypted transport relay.

Candidate ordering is a hard invariant: candidate type wins over numeric priority. A RELAY candidate can therefore never jump ahead of a HOST or SERVER_REFLEXIVE candidate by advertising a larger priority.

A ticket with only relay Host candidates is rejected. This keeps P2P-first as an architectural property rather than a best-effort comment.

## What remains centralized

The minimal control plane still owns the pieces that require global authority:

- account authentication;
- rental creation and payment state;
- machine discovery/presence;
- lease issuance and fencing;
- short-lived rendezvous authorization;
- abuse/security policy and revocation;
- small metering/control events.

It does **not** carry the GPU workload itself.

## Agent Candidate Discovery v1

`agent/gpubnb_agent/p2p_connectivity.py` implements the first Agent-side layer:

- it binds one real UDP socket to an ephemeral port and returns ownership of that
  live socket to the caller; future QUIC code must consume that socket rather than
  bind a replacement port;
- it filters loopback, unspecified, multicast and link-local interface addresses;
- it sends bounded RFC 8489 Binding requests only to operator-configured STUN
  servers and strictly validates the response header, transaction ID, cookie,
  framing and IPv4/IPv6 `XOR-MAPPED-ADDRESS`;
- it verifies the Control Gateway Ed25519 ticket using exactly the signing byte
  sequence in `services/control-gateway/src/p2p.rs`, including candidate order;
- it rejects stale or incorrectly scoped lease authority before exposing network
  attempt targets and returns HOST, SERVER_REFLEXIVE, then RELAY attempts.

Discovery results are session negotiation data. Public or private endpoints must
not be copied into heartbeat, general telemetry, logs or exception messages.
Only stable failure codes and candidate classes may be counted operationally.

The implementation prefers one IPv6 dual-stack socket so IPv4 and IPv6 candidates
share the same reserved port, and falls back to IPv4 when the platform cannot
provide dual-stack UDP. The Direct QUIC phase must preserve that socket ownership.

## Direct QUIC Session v1

`agent/gpubnb_agent/p2p_direct_quic.py` explicitly adapts aioquic to the live
Candidate Discovery socket. The high-level `aioquic.connect()` helper is not used
because it always allocates and binds a new UDP socket. Both the renter client and
Host listener instead call `create_datagram_endpoint(sock=reserved_socket)`, which
transfers the exact socket and NAT mapping into aioquic without closing or
rebinding it.

QUIC TLS verification remains mandatory and uses operator-provided trust roots;
`CERT_NONE`, `verify=False`, and implicit public CAs are rejected. Above TLS, a
four-message `HELLO -> CHALLENGE -> FINISH -> READY` handshake authenticates the
Host and Renter with their rendezvous Ed25519 keys. Every signature is domain
separated and binds the protocol version, roles, ticket nonce, `sessionId`,
`machineId`, `leaseId`, `fencingToken`, and both fresh challenges. The Host replay
cache consumes the ticket/challenge pair until ticket expiry. No workload stream
is exposed before `READY` is verified.

Only signed HOST and SERVER_REFLEXIVE endpoints are punched or dialled. Attempts
are bounded per candidate and globally, and preserve type order regardless of
numeric priority. Lease/fencing authority is checked before each attempt and at
each handshake transition. Reconnect uses the same path and therefore cannot
revive an expired ticket or cross a fencing-token rotation.

The Edge tunnel remains intact. `HostTunnelSupervisor.reconcile_after_direct()`
starts it only after a terminal bounded direct failure and only when the signed
relay policy permits fallback. `DIRECT_ONLY` never starts the tunnel.

## What this PR does not claim

This v1 includes a deterministic mutual-TLS QUIC loopback test, bounded signed
candidate punching, and the authenticated application handshake. A loopback or
simulated CI test does **not** prove that P2P works across the public Internet.
Symmetric NAT, restrictive enterprise firewalls, IPv4 CGNAT, IPv6 and mobile
networks still require the real two-network NAT-to-NAT qualification below before
any production direct-connect success claim.

## Cost model

The architectural intent is that adding active GPU Hosts also adds the machines doing the expensive compute and session traffic. GPUbnb's own managed services scale mostly with lightweight control operations. Relay bandwidth remains a variable cost only for sessions where direct connectivity cannot be established.
