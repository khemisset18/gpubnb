# P2P physical qualification — 2026-08-17

## Scope

This document records physical qualification evidence for the direct QUIC P2P path implemented by PR #122 and the qualification-only ticket tooling in PR #123.

The evidence intentionally excludes private signing keys, TLS private keys, raw endpoint lists, and other secrets.

## Software under qualification

- PR #122: `feat(p2p): direct QUIC session v1`
- PR #123: `feat(p2p): add qualification ticket issuer`
- Direct policy: `DIRECT_ONLY`
- Signed rendezvous ticket maximum TTL: 120 seconds
- Candidate Discovery socket is preserved into the QUIC attempt path by the implementation under test.

## Test 1 — same-network smoke qualification

Purpose: validate the complete qualification flow before the Internet run.

Observed HOST result:

```json
{"latencyMs":1043,"result":"DIRECT_HOST","role":"HOST","success":true}
```

Observed RENTER result:

```json
{"attempts":1,"candidateKind":"HOST","failureCode":null,"fallbackRequired":false,"latencyMs":500,"reconnect":false,"result":"DIRECT_HOST","role":"RENTER","success":true}
```

Result: authenticated direct QUIC session established successfully with no relay fallback.

## Test 2 — real two-network Internet qualification

### Physical topology

- PC A: HOST connected through the home Internet connection.
- PC B: RENTER connected to an iPhone 4G/5G hotspot.
- The RENTER hotspot association was explicitly checked immediately before the qualification run.
- Rendezvous artifacts were exchanged over HTTPS.
- Relay policy remained `DIRECT_ONLY`.

### Observed HOST result

```json
{"latencyMs":3850,"result":"DIRECT_HOST","role":"HOST","success":true}
```

### Observed RENTER result

```json
{"attempts":2,"candidateKind":"HOST","failureCode":null,"fallbackRequired":false,"latencyMs":3453,"reconnect":false,"result":"DIRECT_HOST","role":"RENTER","success":true}
```

### Qualification conclusion

The direct QUIC path established a real authenticated peer-to-peer session between two physical Windows machines on two different Internet access networks.

Evidence from both roles confirms:

- `success=true`
- direct path selected (`DIRECT_HOST`)
- no relay fallback (`fallbackRequired=false` on RENTER)
- signed qualification ticket accepted
- authenticated QUIC session completed on both peers

This satisfies the previously missing real two-network direct Internet qualification for the current P2P implementation.

## What this result does not prove

The successful Internet run selected a `HOST` candidate. Therefore this evidence does **not** by itself prove all NAT traversal classes.

Still to qualify separately:

- IPv4 hole punching through a `SERVER_REFLEXIVE` candidate
- symmetric NAT behavior
- CGNAT combinations
- restrictive firewall behavior
- IPv6-only / IPv4-only combinations
- fallback relay behavior when direct connectivity is impossible
- revocation and failure behavior during a live Internet session

A `DIRECT_HOST` success across two independent Internet access networks is a valid proof of real direct Internet P2P connectivity, but it must not be described as universal NAT traversal coverage.

## Next product-level qualification

The next milestone is a real end-to-end GPU workload over the qualified session:

1. create / acquire a valid reservation and lease;
2. establish the signed direct P2P session;
3. submit a real GPU workload from the RENTER;
4. execute it on the HOST GPU;
5. return workload output to the RENTER;
6. verify lease/fencing enforcement during execution;
7. capture metering and completion evidence;
8. test failure/revocation behavior;
9. repeat on at least one additional network/NAT topology.

Only after that workload-level evidence should the project claim a fully functioning rental flow rather than only a functioning direct transport path.
