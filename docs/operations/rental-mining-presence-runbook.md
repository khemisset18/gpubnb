# Rental Stop / Mining Control / Hot Presence Runbook

## Scope

This runbook covers the staged migration of durable machine commands and scheduler liveness to the regional Gateway. It assumes Regional Connection Gateway v1 and Agent Control Channel v1 are already deployed and qualified.

No rollout begins from this document with a non-zero value. Production changes require the normal deployment approval process and observable canary evidence.

## Default safe state

```text
MACHINE_PRESENCE_MODE=legacy
AGENT_CONTROL_CHANNEL_ROLLOUT_BPS=0
MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS=0
SCHEDULER_HOT_PRESENCE_ROLLOUT_BPS=0
```

The API/worker rejects command or hot-presence rollout values larger than the Agent Control Channel rollout.

## Private Gateway coordinates

The Delivery Worker needs private service-to-service coordinates only when direct command rollout is non-zero:

```text
CONTROL_GATEWAY_ADMIN_URL=http://control-gateway.internal:9090
CONTROL_GATEWAY_INTERNAL_TOKEN=<secret-manager-value>
```

The token must match the Gateway admin token and must never be sent to Hosts, browser clients, logs or public assignment responses.

## Preflight

Before any non-zero command rollout:

1. Gateway dark deployment healthy in every intended region.
2. Redis presence TTLs renewing for synthetic Hosts.
3. Agent Control Channel canary already at or above the proposed command cohort.
4. No pending Gateway fencing/ACK alerts.
5. Windows Host installer containing the current Agent build has passed preflight.
6. PostgreSQL `MachineCommand` backlog is stable and no command lease storm is present.
7. Incident operator has access to set command and presence rollout back to zero immediately.

## Durable STOP_RENTAL canary

Recommended sequence:

```text
AGENT_CONTROL_CHANNEL_ROLLOUT_BPS=10
MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS=10
```

`10` basis points = 0.1%.

Observe at minimum:

- `machine_command_gateway_failed` rate;
- command dispatch to terminal ACK latency;
- `ACKNOWLEDGED`, `DEAD`, `EXPIRED` command counts;
- `rental_cleanup_verified` terminal detail code;
- workspace container/proxy/volume/network leak checks;
- reconnect/replay behavior during Gateway restart;
- duplicate command behavior after Delivery Worker restart.

Promotion order:

`0.1% -> 1% -> 5% -> 25% -> 50% -> 100%`

Do not promote if terminal ACK latency, DEAD rate, cleanup leaks or replay anomalies regress relative to the legacy path.

## Presence shadow

Before `hot`, run:

```text
MACHINE_PRESENCE_MODE=shadow
SCHEDULER_HOT_PRESENCE_ROLLOUT_BPS=0
```

Shadow logs `scheduler_presence_shadow` while preserving the existing allocation decision. Compare:

- legacy heartbeat online/offline decision;
- Gateway Redis presence live/missing;
- region/gateway distribution;
- reconnect gaps around Host sleep, network change and Gateway replacement;
- false offline rate for machines that later accept work successfully.

Do not enter hot mode until parity is understood and operational thresholds are defined.

## Presence hot canary

Set `MACHINE_PRESENCE_MODE=hot` while keeping rollout zero first. Then increase only inside the existing Agent QUIC cohort:

```text
AGENT_CONTROL_CHANNEL_ROLLOUT_BPS=10
SCHEDULER_HOT_PRESENCE_ROLLOUT_BPS=10
```

For assigned machines, missing/expired/unreadable or quarantined Gateway presence maps to the generic scheduler error `machine_not_online` before any allocation write.

Promotion order:

`0.1% -> 1% -> 5% -> 25% -> 50% -> 100%`

## Immediate rollback

Command fast path:

```text
MACHINE_COMMAND_GATEWAY_ROLLOUT_BPS=0
```

Scheduler liveness:

```text
SCHEDULER_HOT_PRESENCE_ROLLOUT_BPS=0
MACHINE_PRESENCE_MODE=legacy
```

Agent channel, only if the underlying transport is implicated:

```text
AGENT_CONTROL_CHANNEL_ROLLOUT_BPS=0
```

Do **not** delete Redis ACK records or Host terminal-result state during rollback. They are replay/idempotency evidence and expire through their normal retention policy.

## STOP_RENTAL incident checks

If a stop command does not complete:

1. Inspect the durable `MachineCommand` row and sequence.
2. Check whether the Redis ACK key exists:
   `gpubnb:command-ack:{machineId}:commandId:v1`.
3. Verify the ACK machine ID and sequence match the DB row.
4. Check Agent structured events for `control_mutation_failed`.
5. If `rental_cleanup_unverified`, inspect only the exact session-derived GPUbnb Docker names. Never use wildcard/global prune as incident remediation.
6. If the Host is disconnected, leave the durable command to lease/retry/expire according to policy; do not create an unrelated manual command with a new identity unless the incident procedure explicitly calls for it.

## Mining control status

`START_MINING` and `STOP_MINING` transport/execution are dark-qualified only in this layer. There is deliberately no public owner route enabling remote mining mutations.

Do not create production mining commands manually. The current Agent stop primitive is machine-wide while the product model is per-resource. Public rollout requires resource-scoped durable process fencing and profile-catalog reconciliation first.

## Evidence to attach before promotion

- CI head SHA;
- all repository and Windows preflight workflows green;
- synthetic reconnect/replay test result;
- STOP_RENTAL cleanup leak result;
- command ACK latency histogram for canary;
- presence shadow mismatch rate;
- rollback drill result;
- explicit operator approval for the next basis-point threshold.
