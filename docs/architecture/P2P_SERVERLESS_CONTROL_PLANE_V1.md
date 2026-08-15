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

## What this PR does not claim

This v1 establishes the secure protocol contract and CI gates. It does not claim that real Internet NAT traversal is already complete.

The next Agent layer must gather real HOST and SERVER_REFLEXIVE candidates, perform UDP hole punching/QUIC connection races, report which path won, and request a relay candidate only after direct attempts fail. Symmetric NAT, restrictive enterprise firewalls, IPv4 CGNAT, IPv6 and mobile networks must be qualified with real network tests before claiming a production direct-connect success rate.

## Cost model

The architectural intent is that adding active GPU Hosts also adds the machines doing the expensive compute and session traffic. GPUbnb's own managed services scale mostly with lightweight control operations. Relay bandwidth remains a variable cost only for sessions where direct connectivity cannot be established.
