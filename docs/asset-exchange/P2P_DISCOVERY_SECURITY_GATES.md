# P2P Discovery Security Gates

Status: ARCHITECTURE / NO-TEST WINDOW / NO PUBLIC P2P ACTIVATION

## Purpose

These gates prevent gpu.k.p2p from enabling public P2P discovery before the network-security assumptions have been demonstrated.

They apply only to discovery/connectivity.

They do not replace settlement-chain gates.

No gate may weaken:
- signed offers;
- signed cancellations;
- final signed terms;
- DB accept/cancel serialization;
- recovery-before-lock;
- backend-independent refund.

## P0 — Specification complete

Required:
- P2P discovery protocol documented;
- message domains defined;
- replay controls defined;
- cancellation tombstone semantics defined;
- transport identity separated from trader/wallet identity;
- relay/bootstrap authority explicitly forbidden;
- P2P threat entries assigned.

Current status:
- SPECIFIED;
- not executable.

## P1 — Local implementation only

Allowed:
- local process listeners on isolated test network;
- 3-node local libp2p topology;
- synthetic identities;
- synthetic offers only.

Required evidence:
- invalid signatures rejected;
- oversized messages rejected before crypto;
- duplicate suppression;
- replay cache;
- cancellation tombstone;
- per-peer rate limit;
- no internal/private-network dial from untrusted multiaddr;
- clean shutdown/resource release.

Forbidden:
- public listener;
- public bootstrap;
- public DHT.

## P2 — Adversarial local network

Required:
- Sybil swarm;
- eclipse simulation;
- message flood;
- malformed protobuf/frame corpus;
- duplicate message storm;
- peer score abuse;
- cancellation delay;
- partition/reconnect;
- stale offer replay;
- relay outage;
- bootstrap poisoning;
- resource exhaustion;
- fuzzing of envelope parser.

Pass condition:
- no forged economic validity;
- no reopened consumed/cancelled offer;
- no trade-state mutation from gossip alone;
- no recovery dependency on discovery.

## P3 — Isolated internet-facing lab

Allowed:
- dedicated lab IPs;
- no production user data;
- synthetic offers;
- approved relay/bootstrap nodes.

Required:
- firewall/egress policy;
- SSRF/multiaddr tests;
- DDoS quotas;
- relay resource caps;
- peer diversity measurements;
- NAT/AutoNAT qualification;
- hole-punch behavior;
- telemetry privacy review;
- external port inventory.

Forbidden:
- production accounts;
- production wallet addresses;
- real funds.

## P4 — Hybrid discovery canary

Architecture:
- centralized signed-offer discovery remains authoritative availability fallback;
- P2P may announce/fetch same signed objects;
- acceptance still resolves through existing financial DB boundary.

Required:
- deterministic consistency between centralized and P2P copies;
- signed cancellation propagation SLO;
- rollback/disable switch;
- no settlement dependency on P2P;
- privacy notice reviewed;
- incident runbook.

Canary limits:
- small opt-in population;
- no automatic fallback that changes signed terms;
- no P2P-only offers until evidence is reviewed.

## P5 — Federated discovery

Required:
- multiple independently operated bootstrap/index nodes;
- no single administrative authority required for offer retrieval;
- peer/source diversity monitoring;
- federation replay and conflict rules;
- cancellation propagation under partial outage.

Still forbidden:
- gossip-authoritative acceptance;
- DHT-authoritative offer state.

## P6 — Decentralized discovery candidate

Required:
- Gossipsub security profile qualified;
- DHT record profile qualified if used;
- multi-implementation interoperability where applicable;
- Sybil/eclipsing red-team;
- external P2P/network security audit;
- privacy traffic-analysis review;
- long-duration soak test;
- abuse-response tooling;
- signed release/provenance.

Only after P6 may centralized discovery become optional for offer discovery.

Settlement authority remains unchanged.

## P7 — Direct P2P acceptance research

This is NOT part of V1.

Before researching removal of centralized accept/cancel serialization, a new protocol must prove:

- one whole-fill offer cannot be accepted twice across partitions;
- cancellation and acceptance have deterministic conflict resolution;
- consumed state survives replay/restart;
- Byzantine peers cannot equivocate into two valid settlements;
- honest parties retain recovery;
- formal model covers network partitions;
- protocol does not require blockchain custody by gpu.k.p2p.

Until then:

P2P transport may discover offers, but financial acceptance remains through the existing authoritative Asset Exchange boundary.

## Global kill-switch invariant

P2P discovery can always be disabled without:

- blocking active trade settlement;
- blocking redeem;
- blocking refund;
- blocking recovery;
- corrupting Core GPUbnb.

This invariant is permanent.

## No-test-window state

Current allowed work:
- research;
- documentation;
- threat modeling;
- schema drafts;
- deployment diagrams.

Current forbidden work:
- public listener;
- public relay;
- public bootstrap;
- DHT publishing;
- firewall change;
- production Peer ID;
- production feature enablement.

Current gate:
- P0 only.
