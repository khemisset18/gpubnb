# Control Gateway production runbook

## Service

Binary: `gpubnb-control-gateway`  
Container: `services/control-gateway/Dockerfile`  
QUIC listener: UDP/4443 by default  
Private admin listener: TCP/9090 by default

The control gateway is a regional machine-control service. It is not the renter data plane and must never receive workspace/renter payload traffic.

## Required configuration

```text
GPUBNB_CONTROL_GATEWAY_ID=gateway_eu_0001
GPUBNB_CONTROL_REGION=eu-west-1
GPUBNB_CONTROL_QUIC_BIND=0.0.0.0:4443
GPUBNB_CONTROL_ADMIN_BIND=0.0.0.0:9090
GPUBNB_CONTROL_TLS_CERT=/run/secrets/tls/tls.crt
GPUBNB_CONTROL_TLS_KEY=/run/secrets/tls/tls.key
GPUBNB_CONTROL_REDIS_URL=rediss://...
GPUBNB_CONTROL_INTERNAL_TOKEN=<32+ random bytes from secret manager>
```

Optional bounded controls:

```text
GPUBNB_CONTROL_MAX_CONNECTIONS=50000
GPUBNB_CONTROL_CONNECTION_QUEUE=128
GPUBNB_CONTROL_PENDING_PER_MACHINE=256
GPUBNB_CONTROL_PRESENCE_TTL_SECONDS=60
GPUBNB_CONTROL_HEARTBEAT_TIMEOUT_SECONDS=45
GPUBNB_CONTROL_AUTH_CLOCK_SKEW_SECONDS=30
GPUBNB_CONTROL_COMMAND_RETENTION_SECONDS=300
GPUBNB_CONTROL_MAX_FRAME_BYTES=65536
RUST_LOG=info
```

Do not put the internal token in an image, manifest committed to Git, or command-line argument visible in process listings. Mount it from the platform secret manager.

## Network policy

Public/host-facing:

- allow UDP/4443 from the Internet/host networks to the QUIC listener;
- no TCP fallback in v1;
- TLS certificate must cover the regional gateway DNS name.

Private-only:

- TCP/9090 must be reachable only by regional control workers, load balancer health checks and metrics collectors;
- block TCP/9090 from the public Internet;
- Redis is private-only;
- gateways have no need for direct PostgreSQL connectivity.

## Readiness and liveness

`GET /healthz` proves only that the process/admin server is alive.

`GET /readyz` additionally proves:

- the gateway is not draining;
- Redis responds to `PING`.

Load balancers/service discovery must use `/readyz` for new connection admission and `/healthz` for process restart policy.

A Redis outage intentionally makes the service unready. Do not override this to keep accepting new hosts: presence and authentication fencing require Redis.

## Metrics

Scrape `GET /metrics` on the private listener.

Primary metrics:

```text
gpubnb_control_gateway_active_connections
gpubnb_control_gateway_pending_commands
gpubnb_control_gateway_connections_accepted_total
gpubnb_control_gateway_auth_rejected_total
gpubnb_control_gateway_connections_fenced_total
gpubnb_control_gateway_heartbeats_accepted_total
gpubnb_control_gateway_heartbeats_rejected_total
gpubnb_control_gateway_commands_enqueued_total
gpubnb_control_gateway_commands_backpressured_total
gpubnb_control_gateway_command_acks_total
gpubnb_control_gateway_redis_errors_total
```

Recommended warning/critical gates per replica:

- connection occupancy >= 80% / >= 90%;
- command backpressure > 0.5% / > 2% over 5 minutes;
- Redis errors > 0 for 2 minutes / readiness unavailable;
- heartbeat rejection ratio > 0.1% / > 1%;
- auth rejection anomaly > baseline + 5 sigma or sudden regional spike.

Do not add `machineId`, `commandId`, `bookingId` or `ownerId` as metric labels. Those identifiers belong in structured logs/traces.

## Capacity model

The default 50,000-connection limit is an admission bound, not a guaranteed capacity statement. Qualify each instance type with the exact Rust release, kernel, QUIC transport settings, TLS stack and production-like packet loss before setting the production limit.

A region should maintain spare capacity such that losing one failure domain does not push surviving replicas above the configured maximum. Reconnect storms are part of the capacity test.

Example operational rule:

```text
required_region_capacity >= normal_peak * 1.5
and
capacity_after_largest_failure_domain_loss >= normal_peak * 1.2
```

Tune from measured CPU, memory, handshake rate, UDP packet rate and Redis latency rather than socket count alone.

## Deployment sequence

1. Deploy new replica with routing weight 0.
2. Wait for `/readyz` and synthetic QUIC authentication probe.
3. Verify Redis auth projection lookup and presence claim/touch/release.
4. Add replica to regional gateway candidate set with canary weight.
5. Watch auth rejection, heartbeat rejection, Redis latency and connection occupancy.
6. Increase connection assignment gradually.
7. Keep at least one old version available until rollback window closes.

Never roll every gateway in a region simultaneously. Use failure-domain-aware max unavailable settings.

## Graceful drain

Before planned termination:

1. remove the gateway from new regional routing/admission;
2. allow existing agents to reconnect naturally or close the process with SIGINT/SIGTERM through the orchestrator;
3. the gateway marks itself draining, closes the QUIC endpoint and stops accepting new hosts;
4. agents reconnect to another gateway;
5. old disconnect cleanup cannot delete successor presence because release is `connectionId` fenced.

Kubernetes/nomad/systemd termination grace should be at least 15 seconds. Longer drain windows may be used for very high connection counts.

## Redis incident

Symptoms:

- `/readyz` returns 503;
- `redis_errors_total` increases;
- new authentication fails;
- heartbeats fail and presence expires.

Response:

1. remove affected gateways from regional admission automatically through readiness;
2. verify Redis cluster failover/latency and network path;
3. do **not** point the gateway at PostgreSQL as an emergency heartbeat backend;
4. do **not** disable connection fencing;
5. restore Redis, then re-admit gateways gradually to avoid a reconnect thundering herd.

Active renter QUIC Edge sessions are a separate failure domain and should remain unaffected.

## Reconnect storm

Symptoms:

- handshake rate spikes;
- connection occupancy rises quickly;
- CPU and UDP packet rate saturate;
- Redis auth/presence QPS spikes.

Mitigations:

- QUIC address retry activates under high occupancy;
- hard connection cap refuses excess handshakes;
- regional routing must spill to other healthy gateways/regions;
- agents must use exponential backoff with jitter in the next Agent Control Channel layer.

Do not increase the connection cap during an incident without proving memory/CPU headroom.

## Split-brain / stale gateway

If two gateways temporarily hold sockets for one machine, only the Redis `connectionId` owner can refresh presence. The losing socket receives `STALE_CONNECTION` on heartbeat and is fenced.

Investigate repeated fencing as a routing/network stability problem; do not weaken the ownership check.

## Command delivery incident

`QUEUED_BACKPRESSURE` means the gateway retained the command in its bounded delivery journal but the connection send channel was full.

Response:

1. inspect per-replica connection/command pressure;
2. verify agent read loop health;
3. verify Redis ACK writes;
4. allow the durable API outbox to retry unacknowledged commands;
5. never mark a booking/session successful merely because the gateway accepted a command.

A gateway process crash can lose its in-memory journal. This is expected. Durable outbox redelivery + command idempotency is the recovery mechanism.

## Security incident / key revocation

Mark the machine authentication projection `REVOKED`. New gateway authentication then fails closed.

If an already-connected compromised host must be removed immediately:

- quarantine it in durable control state;
- advance the authoritative phase fence and set `QUARANTINED`;
- remove/expire its presence or terminate its gateway connection through the operational control plane;
- rotate the agent key before reactivation.

Do not reuse a revoked key version.

## SLO qualification before production cutover

A release is eligible for canary only after:

- Rust format/test/clippy all green;
- real Redis contract test green;
- release container builds;
- synthetic valid/invalid signature tests green;
- reconnect/fencing test green;
- stale heartbeat sequence test green;
- stale resource lease command rejection green;
- bounded queue/backpressure test green;
- one-gateway-loss reconnect test completed in staging;
- no high/critical container vulnerabilities accepted without explicit security review.

Production agent migration remains feature-flagged and separate from deploying this service.
