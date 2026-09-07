# GPUbnb provider-neutral runtime process topology

Last audited: 2026-09-07.

`deploy/runtime-processes.json` is the provider-neutral deployment contract for the Node control plane. A cloud/provider manifest may implement this contract, but must not silently redefine it.

## Required process roles

### database-migrate

One-shot command:

```text
./node_modules/.bin/prisma migrate deploy
```

It must finish successfully before a new API or delivery-worker release is considered ready.

### api

Long-lived service command:

```text
node dist/server.js
```

Required health endpoint: `/ready`.

The API owns HTTP/auth/agent endpoints, the current workspace HTTP/WebSocket gateway, reconciliation fallback and offline/stale-job sweeps. Its recurring background work is fenced by Redis distributed task leases so replica count is not a correctness assumption.

### delivery-worker

Long-lived worker command:

```text
node dist/delivery-worker.js
```

The worker is not optional. It owns durable outbox publication, machine-command delivery and participates in development-booking reconciliation under the shared Redis scheduler lease.

A deployment that starts only the API can appear healthy while durable commands/outbox work stop progressing. Deployment-readiness therefore fails when this role is absent from the topology contract.

## Shared image

All three roles use the artifact built by `apps/api/Dockerfile`. The runtime must remain non-root (`app`). A provider is free to override the image command for each process role.

## Required dependencies

Both long-lived roles require:

- PostgreSQL via `DATABASE_URL`;
- Redis via `REDIS_URL`.

Redis currently requires TTLs, atomic one-time consumption (`GETDEL` semantics), Lua scripts and Streams in addition to ordinary key/value operations. Replacing Redis therefore requires semantic replacements, not merely changing an endpoint.

## Provider migration rule

When moving between providers, map the provider's service/process primitives to this contract and verify:

1. migrations run once for the release before application readiness;
2. at least one API instance is healthy on `/ready`;
3. at least one delivery worker is running and emitting `delivery_worker_health`;
4. API and worker reach the same PostgreSQL database and Redis coordination plane;
5. public web origins point at the intended API/gateway runtime;
6. a durable machine command and an outbox event both progress end-to-end.

Do not delete a legacy provider manifest merely because its public hostname was removed from the frontend. Delete it only after the live provider implements and passes this runtime contract.
