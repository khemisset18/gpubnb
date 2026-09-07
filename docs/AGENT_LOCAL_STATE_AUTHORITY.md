# Agent local state and durable authority boundary

## Purpose

The GPUbnb Host agent keeps a small amount of private state on the Host so it can authenticate, survive process restarts and resume the control channel. This local state is **not** the source of truth for a rental.

The core reliability rule is:

> A Host-local file may help the agent resume or deduplicate transport work, but it must never become authoritative for booking ownership, job ownership, execution leases, payment state, machine moderation, workspace lifecycle or settlement.

Those durable decisions belong to the API and PostgreSQL.

## Source-of-truth map

| State | Authority | Notes |
|---|---|---|
| Agent private Ed25519 key | Host-local protected file | Private identity material must stay on the Host; it is not application database state. |
| Agent configuration / machine fingerprint | Host-local protected file | Installation identity and local configuration. |
| Signed request counter | Host-local protected file | Replay-protection support for the agent protocol. |
| Control-channel last ACK sequence | Host-local resume cache | Used to resume/deduplicate transport after restart; not rental ownership. |
| Recent terminal command ACKs | Host-local bounded resume cache | Bounded to 64 validated terminal results. |
| Booking | PostgreSQL/API | Durable marketplace authority. |
| GPU job and current attempt | PostgreSQL/API | Durable work authority. |
| Execution lease and fencing/ownership decision | PostgreSQL/API | Local files must not create or extend an execution lease. |
| Workspace session lifecycle | PostgreSQL/API | Local Docker state is evidence/runtime state, not the durable booking lifecycle authority. |
| Machine quarantine / moderation | PostgreSQL/API through `quarantine-service.ts` | Host diagnostics provide evidence; API transaction owns the state transition. |
| Payment / settlement | PostgreSQL/API settlement pipeline | Never inferred from Host-local state. |
| Heartbeat / gateway hot liveness | Redis + fresh API observations | Ephemeral signal, intentionally rebuildable. |

## `control-channel-state.json`

The control channel persists only this canonical schema:

```json
{
  "schemaVersion": 1,
  "lastAckedCommandSequence": 42,
  "terminalResults": []
}
```

`terminalResults` is a bounded cache of recent terminal acknowledgements with the exact fields:

- `commandId`
- `sequence`
- `status`
- `detailCode`

The loader validates IDs, terminal statuses, detail codes and sequence bounds. Cached entries whose sequence is ahead of the persisted last-ACK sequence are ignored. At most the last 64 entries are considered.

Extra JSON fields are intentionally ignored as authority. A valid resume sequence remains usable so an old or extended file does not force the Host to replay everything from sequence zero. On the next successful save, the agent rewrites the canonical three-key schema, removing those extra fields.

This means a stray `bookingId`, `jobId`, `lease`, `payment`, or similar field in the local JSON cannot change the rental authority model.

## Sequence bound

Control-command sequences and persisted ACK sequences are bounded to signed PostgreSQL/BIGINT range:

`1 .. 9,223,372,036,854,775,807` for commands, with `0` also allowed for the persisted "nothing acknowledged yet" state.

The inbound command is rejected before command execution if its sequence is outside that range. This avoids executing a command that cannot later be represented safely in durable gateway/control-plane storage or the local resume cache.

## Restart behavior

### Normal agent restart

1. The agent reloads its local key/configuration.
2. The control channel loads the validated last ACK sequence and bounded terminal-result cache.
3. It presents the last ACK sequence in the signed client hello.
4. The gateway/API remains responsible for deciding which durable command/job still exists and may be delivered.
5. Any rental execution still requires the API's current job/lease/fencing checks.

### Missing local resume file

The agent resumes with ACK sequence `0` and an empty terminal cache. This can cause the control plane to redeliver commands, so command handling must remain idempotent and protected by the durable API job/lease model. Losing this file must not create a booking or lease.

### Unsupported schema or invalid persisted sequence

The resume cache is treated as unusable and loads as sequence `0` with no cached terminal results. The durable API/PostgreSQL state remains unchanged and authoritative.

### Invalid cached result rows

Invalid rows are ignored individually. A valid persisted last ACK sequence is preserved, preventing one damaged cache row from forcing an unnecessary global sequence regression.

### Corrupt JSON

`storage.py` treats malformed JSON as a corrupted control-channel state file. The failure is contained by the agent/control-channel fallback behavior; operators should inspect/replace the local resume cache rather than modifying PostgreSQL rental truth to match the bad file.

## Security and filesystem durability

`agent/gpubnb_agent/storage.py` writes private agent state atomically through a temporary file, flush + `fsync`, then `os.replace`.

On Unix-like systems, the configuration directory/file permissions are restricted to `0700`/`0600`. On Windows, the agent uses `icacls` to remove inherited access and grant the active identity plus `SYSTEM` full access. The Ed25519 private key must never be copied into logs, frontend state, Redis or ordinary API payloads.

## Development invariants

Future changes must preserve all of these rules:

1. Do not persist booking/job/payment/workspace authority in `control-channel-state.json`.
2. Do not let local resume state create, renew or override a PostgreSQL execution lease.
3. Validate inbound command sequence before executing its handler.
4. Keep terminal ACK history bounded and shape-validated.
5. Preserve idempotency because loss of a local cache can cause safe redelivery.
6. Keep private Host identity material local and protected.
7. Treat Redis liveness as ephemeral and PostgreSQL business state as durable.
8. Document any new local file and explicitly state whether it is identity, cache, evidence or authority.

Related architecture: `docs/architecture/AGENT_CONTROL_CHANNEL_V1.md`, `docs/INFRASTRUCTURE_SOURCE_OF_TRUTH.md`, `docs/RELIABILITY_SWEEP_FENCING.md`, and `docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md`.
