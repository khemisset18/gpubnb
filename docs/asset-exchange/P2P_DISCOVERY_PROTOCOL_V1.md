# P2P Offer Discovery Protocol V1

Status: ARCHITECTURE / RESEARCHED / NO-TEST WINDOW / NON-AUTHORITATIVE NETWORK

## Purpose

gpu.k.p2p Asset Exchange is a P2P asset market.

P2P discovery MUST NOT become settlement authority.

The network may transport:
- signed offers;
- signed cancellations;
- signed availability hints;
- peer contact hints;
- retrieval/index information.

The network MUST NOT decide:
- who owns funds;
- whether a trade is completed;
- whether a refund is disabled;
- whether a signature is valid without local verification;
- whether a chain event is final;
- whether a settlement path is safe.

Signed terms, PostgreSQL trade truth, chain evidence and recovery rules remain authoritative.

## Deployment strategy

V1 production discovery remains centralized order discovery with signed offers.

Future P2P discovery is additive.

Rollout phases:

1. CENTRALIZED_DISCOVERY
   - current server index;
   - signed offers;
   - signed cancellations;
   - no P2P network dependency.

2. HYBRID_DISCOVERY
   - centralized index remains available;
   - signed offer gossip;
   - peers may fetch offers from each other;
   - settlement remains unchanged.

3. FEDERATED_P2P_DISCOVERY
   - multiple independently operated index/bootstrap nodes;
   - signed records only;
   - no single discovery authority.

4. DECENTRALIZED_DISCOVERY
   - libp2p-based offer dissemination;
   - optional DHT/provider indexes;
   - settlement still independent.

No rollout phase may make refund or recovery depend on discovery availability.

## Identity separation

Three identities are distinct:

1. libp2p Peer ID
   - transport identity;
   - used for secure channel establishment and peer scoring.

2. Asset Exchange trader identity
   - maker/taker identity used in signed offers/acceptance/cancellation.

3. Blockchain settlement identity
   - wallet/address/public-key identity for the specific chain.

They MUST NOT be treated as interchangeable.

A Peer ID is not proof of wallet ownership.

A wallet signature is not permission to impersonate another Peer ID.

## libp2p research basis

Current libp2p documentation supports:

- encrypted authenticated peer connections;
- QUIC/TCP transports depending on implementation;
- AutoNAT for reachability detection;
- Circuit Relay v2 for relayed connectivity;
- decentralized hole punching via relay coordination;
- Gossipsub mesh dissemination;
- peer scoring and rate-limiting concepts.

Circuit Relay improves reachability but is not anonymity.

Peer IDs and relay paths may create metadata that must be treated as privacy-sensitive.

## Transport profile

Preferred native-node transport sequence:

1. QUIC when supported by the chosen implementation;
2. TCP fallback;
3. Circuit Relay v2 when direct reachability is unavailable;
4. hole punching to upgrade relayed paths to direct paths.

No participant-provided transport address may be trusted without validation.

Private/internal addresses must not be advertised publicly.

Forbidden dial targets include:
- loopback addresses except explicit local-agent channels;
- cloud metadata;
- Core Redis/Postgres;
- internal control-plane hosts;
- RFC1918/internal ranges unless explicitly allowed by deployment policy.

## Browser strategy

Browser support MUST be treated separately from native-node support.

Do not assume native QUIC libp2p support in browsers.

Potential browser transports require separate qualification:
- WebRTC;
- WebTransport;
- secure WebSocket to an approved gateway/relay.

The browser is not allowed to weaken offer-signature verification.

## Message domains

Every application-level P2P message has its own domain.

Examples:

GPUBNB:ASSET-EXCHANGE:P2P:OFFER:v1
GPUBNB:ASSET-EXCHANGE:P2P:CANCEL:v1
GPUBNB:ASSET-EXCHANGE:P2P:ANNOUNCE:v1
GPUBNB:ASSET-EXCHANGE:P2P:REQUEST:v1

The embedded economic object also retains its existing domain.

For example:
- an offer remains OFFER:v1;
- a cancellation remains CANCEL:v1.

The P2P envelope does not replace the economic signature.

## Offer envelope

A P2P offer announcement should bind:

- p2pProtocolVersion;
- envelopeId;
- deploymentId;
- senderPeerId;
- offerHash;
- signedOffer;
- offerSignature;
- announcedAtUnixMs;
- expiresAtUnixMs;
- sequence;
- supportedRetrievalProtocols;
- envelopeSignature.

Rules:

- offerHash must match local canonical bytes;
- offer signature must verify independently;
- envelope signature must bind transport announcement;
- offer expiry remains authoritative over envelope expiry;
- envelope cannot extend economic offer expiry;
- unknown critical fields reject;
- oversized envelopes reject.

## Cancellation propagation

Cancellation is a signed tombstone.

A cancellation announcement must include:

- offerId;
- offerHash;
- signed cancellation;
- cancellation signature;
- cancellationHash;
- announcedAtUnixMs;
- expiresAtUnixMs;
- envelope signature.

Rules:

- valid cancellation always wins over stale offer gossip;
- peers must retain cancellation tombstones long enough to suppress replay;
- network partitions may delay cancellation propagation;
- local acceptance must still perform final authoritative offer-state resolution;
- P2P gossip alone cannot make an acceptance final.

## Replay protection

Replay controls include:

- economic nonce;
- economic expiry;
- P2P envelopeId;
- senderPeerId;
- sequence;
- deploymentId;
- protocol version;
- offer/cancellation hash;
- local consumption state.

A replayed valid offer may be cached/indexed but cannot create another economic acceptance.

A replayed cancellation cannot create a new effect after the original cancellation has been consumed.

## Topic design

Do not create one global topic containing all assets.

Candidate topic hierarchy:

/gpubnb/asset-exchange/v1/<environment>/offers/<family>

/gpubnb/asset-exchange/v1/<environment>/cancellations

Examples:

/gpubnb/asset-exchange/v1/prod/offers/utxo
/gpubnb/asset-exchange/v1/prod/offers/evm
/gpubnb/asset-exchange/v1/prod/offers/solana

Further partitioning by exact asset/network may be introduced only after measuring privacy, bandwidth and eclipse implications.

Topic names MUST NOT contain:
- wallet addresses;
- trade secrets;
- personal identifiers;
- KYC state.

## Gossipsub role

Gossipsub is transport for announcements, not truth.

Required application controls:

- message size cap;
- per-topic rate cap;
- per-peer rate cap;
- duplicate suppression;
- signed-message validation;
- TTL;
- peer scoring;
- graylisting;
- malformed-message penalties;
- backoff;
- IP/network diversity controls;
- resource quotas.

A high-scoring peer is still not settlement authority.

## Sybil resistance

Peer scoring is not sufficient Sybil resistance.

V1 must assume attackers can create many Peer IDs.

Therefore:
- economic validity always comes from signatures;
- acceptance state is serialized by financial DB logic;
- offer creation can be rate-limited independently;
- peers may impose proof-of-work or stake-like admission only through a separately reviewed mechanism;
- do not require token staking merely to make the network function;
- do not rely on IP uniqueness as identity.

## DHT use

The DHT may be used only for discovery/index hints.

Safe candidate uses:
- provider discovery for offer-hash prefixes;
- discovery of relay/bootstrap services;
- discovery of retrieval endpoints.

Unsafe uses:
- storing authoritative trade state;
- deciding whether an offer is cancelled;
- storing private recovery material;
- storing KYC data;
- storing wallet identifiers unnecessarily.

DHT records must be bounded, signed and expiring.

## Retrieval protocol

Gossip announcements should remain small.

Large signed offers or metadata may be fetched directly.

Candidate request:

GET_OFFER
- protocol version;
- offerHash;
- request nonce.

Candidate response:
- exact signed offer bytes;
- signature;
- optional signed cancellation if already cancelled.

The receiver recomputes all hashes and signatures.

No HTTP-style redirect from an untrusted peer may send the client to arbitrary internal addresses.

## Privacy model

P2P discovery leaks metadata by design.

Potentially visible:
- Peer ID;
- timing;
- topic subscriptions;
- relay usage;
- IP address for direct peers;
- interest in asset families;
- offer publication timing.

Therefore:
- no KYC state on P2P network;
- no email/account profile;
- no exact wallet address unless required by already-signed offer semantics;
- avoid long-lived correlation identifiers;
- rotate transport metadata only if compatible with anti-abuse controls;
- document that Circuit Relay is encrypted transport, not anonymity.

Privacy promises MUST NOT claim Tor-like anonymity unless a separately reviewed anonymity network is actually used.

## Relay policy

Circuit Relay v2 may be used for reachability.

Relay operators:
- cannot be settlement authority;
- cannot receive wallet secrets;
- cannot receive recovery keys;
- must have bandwidth/time/resource limits;
- must be independently replaceable.

Loss of all relays may reduce discovery/connectivity but MUST NOT strand locked funds.

## Bootstrap policy

Bootstrap nodes are availability infrastructure only.

At least two independent bootstrap operators are preferred before decentralized production rollout.

Bootstrap nodes may provide:
- initial peer addresses;
- protocol version information;
- public relay endpoints.

They must not provide:
- authoritative balances;
- authoritative offer state;
- recovery secrets.

Client must continue working with alternative bootstrap sources where possible.

## Eclipse resistance

Mitigations:

- diverse peer sources;
- diverse IP/network prefixes;
- multiple bootstraps;
- opportunistic mesh improvement;
- peer score decay;
- maximum connections per IP/prefix;
- validation against authoritative economic signatures;
- optional centralized/federated cross-check during hybrid phase.

Even under eclipse:
- attacker must not be able to forge maker signatures;
- attacker must not disable refund;
- attacker must not mutate final signed terms.

## Spam / DoS

Bound:

- maximum envelope bytes;
- maximum offer bytes;
- maximum announcements per second;
- maximum outstanding fetches;
- maximum offers cached per peer;
- maximum tombstones;
- CPU budget for signature verification;
- memory budget per topic;
- connection count;
- concurrent streams.

Expensive cryptographic checks should occur only after cheap structural validation.

## Asset routing

P2P discovery MUST use canonical asset registry identity.

Never route by symbol alone.

Examples:

USDT Ethereum != USDT Solana != USDT Tron.

BTC mainnet != BTC regtest.

Zcash transparent != Sapling != Orchard != Ironwood.

An offer referencing an unknown or quarantined asset may be stored only if policy allows marketplace visibility; it cannot create an automatic settlement route.

## Mode isolation

Conformité and Souverain modes may use the same P2P transport.

P2P transport must not carry KYC records.

If Conformité mode requires eligibility:
- eligibility is checked at the Asset Exchange application boundary;
- P2P announcements reveal only the minimum signed eligibility capability if needed;
- no Core account/KYC propagation.

Mode transition must:
- stop new commitments;
- preserve cancellation;
- preserve settlement;
- preserve refund/recovery.

## Acceptance flow

Safe future hybrid flow:

1. maker builds canonical offer;
2. maker signs OFFER:v1;
3. local client publishes to centralized index and/or P2P;
4. taker receives signed offer;
5. taker verifies locally;
6. taker requests authoritative acceptance through Asset Exchange financial boundary;
7. DB serializes accept-vs-cancel race;
8. both parties sign final settlement terms;
9. chain adapter handles recovery-before-lock;
10. settlement proceeds independently of discovery network.

Direct peer-to-peer acceptance without authoritative race serialization is a future protocol and is NOT approved by V1.

## Failure scenarios

### Discovery network offline

Allowed outcome:
- no new offers discovered.

Forbidden outcome:
- existing refund unavailable;
- locked trade stuck because discovery is offline.

### Maker disappears

Taker relies on:
- signed offer;
- signed final terms;
- chain-specific protocol;
- recovery conditions.

Not on maker's online presence unless protocol explicitly requires it before lock.

### Malicious relay

Relay may:
- delay;
- drop;
- observe metadata.

Relay must not be able to:
- forge offer;
- mutate signed terms;
- steal funds;
- disable refund.

### Malicious bootstrap

Bootstrap may send bad peers.

Client must validate all peer identities/messages independently.

### Partition

Different partitions may see different open-offer sets.

Final acceptance still resolves through authoritative state in V1/hybrid.

After reconnection:
- signed cancellations suppress stale offers;
- consumed offers cannot reopen.

## Observability

Metrics may include:
- peer count;
- relay usage;
- topic message rate;
- invalid-signature count;
- duplicate rate;
- cancellation propagation latency;
- fetch success rate;
- peer-score distribution.

Logs must not include:
- private keys;
- recovery secrets;
- KYC data;
- full wallet addresses unless necessary and approved.

## No-test-window rule

Allowed now:
- protocol specification;
- threat modeling;
- transport research;
- message-schema design;
- future test plans.

Forbidden now:
- enabling public libp2p listeners;
- enabling DHT writes;
- enabling automatic P2P acceptance;
- opening new firewall ports;
- deploying relays;
- claiming P2P discovery production-ready.

## Future qualification plan

When testing resumes:

1. local 3-node network;
2. signed offer propagation;
3. invalid signature rejection;
4. replay storm;
5. cancellation tombstone propagation;
6. partition + stale-offer recovery;
7. duplicate Peer IDs impossible by cryptographic identity;
8. peer-score abuse;
9. Sybil simulation;
10. message flood;
11. oversized messages;
12. relay-only peers;
13. NAT/hole-punch;
14. relay failure;
15. multiple bootstraps;
16. eclipse simulation;
17. mixed centralized + P2P consistency;
18. browser/native interoperability;
19. privacy metadata review;
20. external network security review.

No public network rollout before these gates are reviewed.
