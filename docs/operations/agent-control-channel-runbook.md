# Agent Control Channel v1 — operations runbook

## Scope

This runbook covers the Host-to-Regional-Gateway QUIC control channel. It does not change renter-byte traffic, escrow settlement or the durable HTTPS job lease protocol.

## Safe default and emergency rollback

The global safe default is:

```text
AGENT_CONTROL_CHANNEL_ROLLOUT_BPS=0
```

Setting rollout back to `0` is the primary emergency rollback. Hosts refresh their signed assignment periodically and return to the existing HTTPS job polling path without reinstalling or rotating their machine key.

Do not delete Host `control-channel-state.json` during a routine rollback. It contains the terminal resume sequence used to prevent a command from being re-executed after a crash or reconnect.

## Preconditions before any non-zero rollout

- Regional Gateway health and readiness are green.
- Public UDP reachability to the configured gateway port is tested from outside the deployment network.
- The public TLS certificate validates for `CONTROL_GATEWAY_TLS_SERVER_NAME`.
- Machine authentication cache projection is healthy.
- Redis presence/fencing tests are green.
- Agent `0.6.0` package/installer qualification is green.
- One synthetic Host has completed connect, reconnect, pushed wake, HTTP lease claim and terminal ACK.
- Legacy HTTPS heartbeat and job endpoints remain healthy.

## Canary sequence

Promote one region at a time. Suggested gates are `10`, `100`, `500`, `2500`, `5000`, then `10000` basis points, corresponding to 0.1%, 1%, 5%, 25%, 50%, and 100% of the deterministic machine buckets.

Hold or roll back when authentication rejection, fencing, reconnect churn, duplicate-job evidence, terminal-ACK errors or fallback-poll failures rise above the region's normal baseline.

## Host events

The Host emits bounded structured events relevant to this channel:

- `control_channel_assignment` — assignment changed;
- `control_channel_connected` — authenticated QUIC session established;
- `control_channel_disconnected` — transport/session failed and reconnect backoff started;
- `control_channel_fenced` — Gateway explicitly revoked this connection;
- `control_channel_assignment_error` — signed assignment refresh failed; HTTPS remains active;
- `control_channel_local_init_error` — Host could not initialize the optional channel; HTTPS remains active;
- `job_wake_coalesced` — another local job wake/poll is already executing.

Do not log Agent private keys, signatures, lease tokens, service tokens or full command payloads.

## Incident: widespread disconnect/reconnect storm

1. Confirm Gateway readiness and Redis availability.
2. Check regional UDP reachability and TLS certificate validity.
3. Verify the issue is regional rather than a Host release problem.
4. Reduce rollout or set it to `0` if reconnect churn can affect Host resources.
5. Keep the Gateway deployed for forensic metrics if healthy; disabling assignment is sufficient to restore legacy behavior.
6. Do not disable heartbeat/job APIs during the incident.

Hosts use bounded exponential full jitter with a 60-second ceiling, so recovery should spread reconnect attempts rather than synchronize them.

## Incident: `REPLACED_CONNECTION` or `PRESENCE_OWNERSHIP_LOST`

A small number is expected during restart, network handoff or a second Host process. Persistent repetition for one machine usually indicates duplicate Agent instances, unstable NAT/networking or a stale Gateway instance.

Never bypass `connectionId` fencing to make the symptom disappear. Resolve the duplicate process or Gateway ownership problem.

## Incident: ACK rejected / split-brain suspicion

Treat repeated ACK ownership conflicts as a correctness incident.

- Do not manually rewrite the Redis ACK key.
- Verify the machine has one current presence `connectionId`.
- Verify old Gateway processes are drained or fenced.
- Keep the durable job/outbox state as source of recovery truth.
- Roll rollout to `0` if the problem is systemic.

The Host's terminal result is persisted before terminal network ACK. Preserve that local state during investigation.

## Incident: QUIC blocked by customer firewall

This is a supported migration failure mode. The Host continues signed HTTPS heartbeat and, while the channel is disconnected, uses the legacy job poll path. Do not instruct operators to weaken TLS or disable firewall policy globally.

For managed fleets, permit outbound UDP to the configured public Gateway DNS/port. If UDP cannot be permitted, leave those Hosts on the fallback path until a separately reviewed transport alternative exists.

## Incident: certificate or SNI failure

- Confirm public DNS resolves to the intended regional Gateway.
- Confirm certificate SAN covers the configured TLS server name.
- Confirm Host clock is correct.
- Do not set `CERT_NONE`, disable hostname verification or ship an insecure bypass.

A private CA file is a development/qualification facility and must be distributed through a protected Host configuration channel if ever used outside local testing.

## Local resume-state recovery

Deleting `control-channel-state.json` resets the Host's terminal resume knowledge and can allow replay ambiguity. Do it only as a fenced recovery procedure when all of the following are true:

1. the machine is removed from scheduling;
2. no rental/mining job is active;
3. the old Gateway connection is gone;
4. the durable job/outbox state has been reconciled;
5. an operator records why the sequence reset was safe.

Routine reinstall/upgrade should preserve the private GPUbnb data directory.

## Capacity and latency watch

At each canary stage watch at least:

- active Gateway connections vs configured capacity;
- authentication rejects;
- heartbeat accepts/rejects;
- fenced connections;
- Redis errors;
- pending command count and backpressure;
- command enqueue-to-terminal-ACK latency;
- Host reconnect rate;
- HTTP fallback job-poll rate;
- job lease conflicts/duplicate-attempt evidence;
- API heartbeat latency and failure rate.

Avoid labels containing machine IDs on global metrics. Machine-specific debugging belongs in sampled/logged incident data, not high-cardinality Prometheus dimensions.

## Shutdown and deploy

Drain a Gateway before termination. During rolling deploy, the old instance should stop admitting work, fence/close sessions, and allow Hosts to reconnect with jitter to healthy capacity. The Host resume sequence is signed into the next authentication handshake.

## Roll forward after an incident

Restore rollout gradually rather than jumping directly to 100%. A successful HTTP fallback during an outage demonstrates rollback safety; it does not prove the QUIC fault is fixed. Repeat a synthetic disconnect/reconnect and pushed job wake before increasing the basis-point threshold.
