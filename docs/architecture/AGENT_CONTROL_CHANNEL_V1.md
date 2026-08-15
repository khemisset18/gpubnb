# Agent Control Channel v1

**Status:** implementation baseline / stacked on Regional Connection Gateway v1  
**Purpose:** replace routine command polling with a persistent authenticated Host control channel without bypassing durable job leases  
**Rollout default:** 0 basis points (disabled)  
**Safety posture:** fail closed for command identity, lease binding, replay, unsupported actions and channel assignment

## 1. Decision

GPUbnb Host keeps its existing HTTPS heartbeat, telemetry, job lease and result APIs while adding one long-lived outbound QUIC control connection to the assigned Regional Connection Gateway.

The v1 channel is deliberately a **push/wake transport**, not a second business-state machine. The durable API job protocol remains authoritative for GPU work. A pushed rental/diagnostic command wakes the Host immediately; the Host then claims the existing leased job through HTTPS and executes the same hardened runner already used in production qualification.

```text
                         durable API / PostgreSQL
                         jobs + execution leases
                               ^       |
                     state/results     | durable intent
                               |       v
Host runner <---- HTTPS -------+   regional control worker
     ^                                  |
     | wake                             | bounded command
     |                                  v
Agent Control Channel <--- QUIC --- Regional Gateway
     |
     +---- HTTPS heartbeat/telemetry remains during migration
```

This preserves one source of durable job truth while removing command-delivery latency and, once connected, reducing routine job polling to a bounded safety fallback.

## 2. Startup and rollout assignment

Every linked Host periodically sends a normal signed Agent request to:

`GET /agent/control-channel/{machineId}`

The API verifies the machine Ed25519 identity and returns only transport configuration:

- enabled flag;
- protocol version;
- public gateway DNS name;
- UDP port;
- TLS server name;
- fallback polling interval.

No owner identity, email, wallet, billing data, service token or gateway-admin credential is returned.

Assignment is deterministic per machine. The API hashes a domain-separated machine id and maps it to one of 10,000 buckets. `AGENT_CONTROL_CHANNEL_ROLLOUT_BPS` therefore gives stable canaries without keeping a mutable per-machine rollout table.

Rollout defaults to `0`. A production rollout greater than zero is invalid unless a non-loopback public gateway host is configured.

## 3. Transport and authentication

Transport: QUIC over TLS 1.3  
ALPN: `gpubnb-control/1`  
Protocol: version `1`  
0-RTT: disabled by the Gateway

The Host validates the normal TLS certificate chain and SNI. A custom CA path is supported only through the local Host configuration for development/private qualification.

After QUIC establishment the Host opens one bidirectional stream and sends a bounded `ClientHello` signed by the same Ed25519 machine key already registered during device authorization.

The signature is over the exact domain-separated canonical bytes used by the Gateway:

```text
gpubnb-control-gateway-auth-v1
1
<machineId>
1
<issuedAtMs>
<nonce>
<lastAckedCommandSequence>
```

The signature is hex encoded because the Gateway contract expects a 64-byte Ed25519 signature in hexadecimal form.

## 4. Bounded framing

Every application message is:

```text
4-byte unsigned big-endian length
JSON payload
```

The Host rejects zero-length frames and anything larger than 256 KiB before decoding JSON. Commands additionally enforce the Gateway's 48 KiB payload cap, 15-minute maximum lifetime and two-minute clock-skew hard bound.

Unknown top-level fields, unsupported protocol versions, invalid IDs, wrong machine ids and malformed leases fail closed.

## 5. Reconnect and resume

The Host stores terminal command state in the same private configuration directory as its machine key. Writes are atomic and use the existing restrictive Linux/macOS permissions or Windows ACL path.

Persisted state contains:

- highest terminal command sequence acknowledged;
- a bounded cache of the latest 64 terminal results.

The next `ClientHello` binds that sequence into the Ed25519 signature. The Host requires the Gateway `ServerHello.resumedAfterCommandSequence` to equal the local value before accepting commands.

Reconnect uses bounded exponential full jitter with a hard 60-second ceiling. A channel failure never tight-loops and never disables the HTTPS safety path.

## 6. Crash idempotency

For a new command the Host:

1. validates the command and lease shape;
2. sends `ACCEPTED`;
3. invokes the v1 command adapter;
4. obtains a terminal result;
5. **persists that terminal result atomically**;
6. only then sends the terminal ACK.

If the process crashes between steps 5 and 6, the reconnect presents the persisted terminal sequence. If the command is replayed, the Host returns the stored terminal result and does not run the adapter again.

A replay at or below the persisted terminal sequence without a matching cached result is treated as a protocol error rather than guessed successful.

## 7. Command capability matrix

v1 intentionally enables only commands whose behavior can reuse an already fenced durable path:

| Gateway command | v1 Host behavior |
|---|---|
| `PREPARE_RENTAL` | wake the existing HTTPS job-lease worker |
| `START_RENTAL` | wake the existing HTTPS job-lease worker |
| `RUN_DIAGNOSTIC` | wake the existing HTTPS job-lease worker |
| `REFRESH_INVENTORY` | execute one immediate signed HTTPS telemetry heartbeat |
| `STOP_RENTAL` | reject until a dedicated idempotent stop adapter is qualified |
| `START_MINING` | reject until mining command fencing is wired end-to-end |
| `STOP_MINING` | reject until mining command fencing is wired end-to-end |
| `QUARANTINE` | reject until local quarantine semantics are independently qualified |

`PREPARE_RENTAL` and `START_RENTAL` are also required by the Gateway to carry a live fenced resource lease before they can enter the delivery journal.

The Host does not treat a wake command as ownership of a booking. The subsequent HTTPS job claim still requires the existing `attemptId` + `leaseToken` protocol and all existing job-state validation.

## 8. Polling fallback

Before a Host is assigned, or whenever QUIC is disconnected, the current HTTP behavior remains unchanged.

While QUIC is connected, the existing `run_next_job` hook becomes a safety fallback instead of a per-heartbeat poll. The fallback interval is supplied by the signed assignment and is bounded to 30–900 seconds. Push wakes bypass that delay but are serialized through one local job lock so a fallback poll and a pushed wake cannot concurrently execute two claims in the same process.

If the control-channel module cannot initialize, the entrypoint logs the error and leaves the original HTTPS path intact.

## 9. Telemetry remains separate

This version does **not** remove the signed HTTPS telemetry heartbeat. The heartbeat contains GPU inventory/security observations and feeds durable history, accelerator validation and listing publication logic. Mixing that relatively rich telemetry stream into the lightweight presence channel would enlarge the Gateway hot path and couple scheduling liveness to PostgreSQL telemetry writes again.

A later migration may decouple telemetry cadence from liveness cadence after presence parity is proven.

## 10. Release and compatibility

The Agent version for this channel is `0.6.0`. Both installed console execution and `python -m gpubnb_agent` / frozen PyInstaller execution route through the same migration entrypoint, so Windows Service and interactive Host behavior cannot silently diverge.

The QUIC runtime is pinned in Agent package metadata. CI compiles the package, runs protocol/replay tests and smoke-tests the public entrypoints. Existing repository workflows continue to test the complete Agent, Host installer and API.

## 11. Rollout gates

No automatic production cutover is performed by this implementation. The intended sequence is:

`0% dark -> synthetic Host -> 0.1% -> 1% -> 5% -> 25% -> 50% -> 100%`

Promotion requires, per region:

- no authentication/fencing anomaly;
- reconnect success under gateway restart and network interruption;
- no duplicate durable job execution;
- command ACK success within the expected latency budget;
- fallback polling proven during QUIC/UDP loss;
- no regression in HTTP heartbeat/telemetry publication;
- Windows installed-service qualification;
- clean rollback to rollout `0` without Host reinstall.

## 12. Next layer

After canary evidence is green, the next safe extension is to add dedicated idempotent adapters for `STOP_RENTAL` and mining lifecycle commands, then move scheduler hot-presence reads to the Gateway/Redis path. Those changes should remain separate reviews because they alter business state rather than transport only.
