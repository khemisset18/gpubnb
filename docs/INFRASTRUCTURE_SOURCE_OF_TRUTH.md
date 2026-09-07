# GPUbnb infrastructure source of truth

Last audited: 2026-09-07.

This document separates **confirmed repository facts** from **deployment assumptions**. It exists because the repository contains Supabase, Redis-compatible, Netlify and historical provider references from different deployment eras.

## Confirmed from the current repository

### Frontend

- Static frontend lives in `apps/web`.
- The repository contains Netlify configuration in `netlify.toml`.
- Active browser/build configuration is provider-neutral: the hosted build requires `GPUBNB_API_ORIGIN`, accepts an optional `GPUBNB_GATEWAY_ORIGIN`, and generates the published `_redirects`, `_headers` and gateway browser config from those values.
- Hosted builds fail closed if the API origin is missing, invalid or not HTTPS. No hosting-vendor URL is an approved browser fallback.

### Identity and database

- Browser authentication uses Supabase Auth for Google/e-mail flows and Phantom for wallet authentication.
- The API uses Prisma against `DATABASE_URL`.
- Historical deployment docs explicitly describe Supabase as the PostgreSQL provider.

### Redis/state coordination

- The API still requires `REDIS_URL` and uses Redis for sessions, one-time challenges/nonces, workspace gateway relay queues, access grants, distributed scheduler leases and other coordination state.
- Historical deployment docs explicitly describe Upstash as one Redis provider used by GPUbnb.
- No repository evidence currently proves that Redis state has been migrated into Supabase.

### Application/API runtime

- The production application code is still a long-lived Node/Fastify API in `apps/api`.
- The runtime owns authenticated agent endpoints, background reconciliation loops, workspace gateway HTTP/WebSocket relay, job leases and lifecycle transitions.
- Background reconciliation and sweeps are fenced by Redis-backed distributed task leases, so correctness no longer depends on one API process.
- There is no `supabase/functions` tree and repository search finds no deployed Supabase Edge Function implementation replacing this Fastify service.

### GPU host runtime

- PC A runs the GPUbnb agent and Docker/NVIDIA runtime.
- Developer Workspace traffic is outbound-only from the host. The renter reaches the API/gateway, which relays traffic to the agent/local workspace runtime.

## What is NOT safe to assume

Do not treat any hosting-provider file as the live production source of truth merely because it exists in the repository.

In particular:

- `render.yaml` is a legacy provider deployment artifact; it does **not** prove the current account still uses Render and is not the authoritative runtime topology.
- Supabase PostgreSQL/Auth usage does **not** prove the Fastify/WebSocket API has been migrated to Supabase-hosted Edge Functions.
- Browser/API/gateway origins come from deployment build configuration. Their configured values must be verified against the live deployment rather than inferred from repository history.

## Provider-neutral target architecture

Keep responsibilities explicit:

1. **Frontend** — static web hosting/CDN.
2. **Auth** — Supabase Auth and Phantom wallet auth.
3. **Database** — Supabase PostgreSQL via a pooled server connection.
4. **Ephemeral coordination** — Redis-compatible service while the current relay/session/challenge/lease design depends on Redis semantics.
5. **API/control plane** — a persistent runtime capable of running the Fastify service, authenticated agent APIs and lifecycle operations.
6. **Delivery/background processing** — an explicitly deployed worker process, using the same durable database and Redis coordination but not assumed to exist merely because an API container exists.
7. **Interactive workspace data plane** — a persistent WebSocket-capable runtime with reconnect/resume semantics suitable for rentals lasting many minutes.
8. **GPU host** — Windows/Linux agent + Docker/NVIDIA runtime on provider machines.

The API/control-plane provider is intentionally unnamed here. The deployment target must be supplied as configuration rather than embedded into browser code or tests.

## Supabase hosted Edge Functions: suitability boundary

Supabase Edge Functions can serve HTTP and WebSocket endpoints, but hosted workers have finite wall-clock/runtime limits. A direct lift-and-shift of GPUbnb's long-lived workspace gateway into one Edge Function would therefore require an explicit resumable WebSocket/session design and cannot be treated as a transparent replacement for the current persistent Fastify gateway.

Good candidates for future Supabase Edge Function extraction are short, idempotent HTTP operations that do not depend on the process-resident Fastify lifecycle or long-lived gateway connections. The workspace tunnel/control plane should only migrate after a dedicated resumability design and fault-injection campaign.

## Deployment invariants

Any production deployment must preserve all of these regardless of provider:

- `WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS <= HEARTBEAT_OFFLINE_SECONDS`.
- Claimed job lease duration must leave substantial margin over the agent refresh cadence and transient network interruptions.
- Redis challenge/signature verification must remain outside retryable database callbacks.
- Interactive billing starts only on the first authenticated upstream workspace WebSocket frame.
- `canOpen` must require a fresh machine heartbeat, a valid workspace session, registered gateway metadata and fresh gateway liveness.
- No browser-visible production URL may be hard-coded to a hosting vendor.
- Hosted web builds must fail closed when required public origins are absent or insecure.
- No deployment-specific file may be treated as authoritative unless the live deployment target is verified.
- API and delivery-worker process roles must both be represented in the provider-neutral deployment contract before the legacy provider topology is deleted.

## Migration rule

The active frontend no longer depends on a Render URL, but removing the remaining legacy provider deployment artifact still requires proof of the live runtime responsibilities. Before deleting `render.yaml` (or another provider manifest), first prove where these run today:

- public Fastify API origin;
- workspace WebSocket gateway origin;
- delivery worker;
- background reconciliation/sweep authority;
- Redis endpoint/provider;
- Prisma `DATABASE_URL` target.

Only after those responsibilities are represented by a provider-neutral deployment contract and verified in the live environment should the legacy provider manifest be deleted. This prevents a repository cleanup from silently disconnecting PC A agents, PC B workspace traffic or background delivery processing.
