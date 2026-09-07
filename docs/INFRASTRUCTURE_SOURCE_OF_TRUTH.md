# GPUbnb infrastructure source of truth

Last audited: 2026-09-07.

This document separates **confirmed repository facts** from **deployment assumptions**. It exists because the repository currently mixes Supabase, Upstash, Netlify, Render and local/Caddy references from different deployment eras.

## Confirmed from the current repository

### Frontend

- Static frontend lives in `apps/web`.
- The repository contains Netlify configuration in `netlify.toml`.
- `apps/web/config.js`, `netlify.toml`, `scripts/generate-web-build-info.mjs`, architecture tests and deployment-readiness checks still contain `gpubnb.onrender.com` assumptions.

### Identity and database

- Browser authentication uses Supabase Auth for Google/e-mail flows and Phantom for wallet authentication.
- The API uses Prisma against `DATABASE_URL`.
- Historical deployment docs explicitly describe Supabase as the PostgreSQL provider.

### Redis/state coordination

- The API still requires `REDIS_URL` and uses Redis for sessions, one-time challenges/nonces, workspace gateway relay queues, access grants and other coordination state.
- Historical deployment docs explicitly describe Upstash as the Redis provider.
- No repository evidence currently proves that Redis state has been migrated into Supabase.

### Application/API runtime

- The production application code is still a long-lived Node/Fastify API in `apps/api`.
- The same runtime owns authenticated agent endpoints, background reconciliation loops, workspace gateway HTTP/WebSocket relay, job leases and lifecycle transitions.
- There is no `supabase/functions` tree and repository search finds no deployed Supabase Edge Function implementation replacing this Fastify service.

### GPU host runtime

- PC A runs the GPUbnb agent and Docker/NVIDIA runtime.
- Developer Workspace traffic is outbound-only from the host. The renter reaches the API/gateway, which relays traffic to the agent/local workspace runtime.

## What is NOT safe to assume

Do not treat any hosting provider file as the live production source of truth merely because it exists in the repository.

In particular:

- `render.yaml` proves that Render deployment support exists in Git history; it does **not** prove the current account still uses Render.
- Supabase PostgreSQL/Auth usage does **not** prove the Fastify/WebSocket API has been migrated to Supabase-hosted Edge Functions.
- `gpubnb.onrender.com` hard-coding in the frontend proves configuration drift if the live API moved elsewhere; it must not be used as evidence that Render is still authoritative.

## Provider-neutral target architecture

Keep responsibilities explicit:

1. **Frontend** — static web hosting/CDN.
2. **Auth** — Supabase Auth and Phantom wallet auth.
3. **Database** — Supabase PostgreSQL via a pooled server connection.
4. **Ephemeral coordination** — Redis-compatible service while the current relay/session/challenge design depends on Redis semantics.
5. **API/control plane** — a persistent runtime capable of running the Fastify service, background loops and authenticated agent APIs.
6. **Interactive workspace data plane** — a persistent WebSocket-capable runtime with reconnect/resume semantics suitable for rentals lasting many minutes.
7. **GPU host** — Windows/Linux agent + Docker/NVIDIA runtime on provider machines.

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
- No browser-visible production URL should be hard-coded to a hosting vendor.
- No deployment-specific file may be treated as authoritative unless the live deployment target is verified.

## Migration rule

Before removing Render (or any other provider) from the repository, first prove where the following live responsibilities run today:

- public Fastify API origin;
- workspace WebSocket gateway origin;
- background reconciliation/sweep process;
- Redis endpoint/provider;
- Prisma `DATABASE_URL` target;
- frontend API/gateway configuration.

Only after all six are verified should legacy provider files, redirects and CI assertions be removed. This prevents a cleanup PR from silently disconnecting PC A agents or PC B workspace traffic.
