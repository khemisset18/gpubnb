# Observability correlation contract

Last audited: 2026-09-07.

GPUbnb must make a renter workspace incident diagnosable without searching unrelated logs manually. The critical path is:

`renter HTTP request -> workspace access grant -> gateway browser session -> WebSocket channel -> agent open request -> upstream workspace connection`.

## Canonical identifiers

Use the following keys consistently in structured logs when they are known:

- `requestId` — Fastify request id for the current HTTP request.
- `accessRequestId` — request id of the renter HTTP call that issued the one-time workspace access grant. It is carried through Redis into the gateway browser session so the later WebSocket can be tied back to the original click.
- `bookingId` — durable rental/booking id.
- `jobId` — workspace preparation job id when the session has one.
- `workspaceSessionId` — durable WorkspaceSession id. Existing legacy `sessionId` fields may remain where required by protocol code, but new correlation context should use the explicit name.
- `machineId` — provider machine/host id.
- `channelId` — full ephemeral gateway WebSocket channel id.
- `channel` — short human-readable prefix of `channelId`, retained for existing log searches.
- `openRequestId` — relay request id used for the agent `ws_open` acknowledgement.

These identifiers are not authorization credentials. They can be logged as structured metadata.

## Workspace access propagation

When PC B calls the renter workspace access endpoint, Fastify already owns `request.id`. `issueWorkspaceAccessGrant` stores that id inside the short-lived, one-time Redis grant record alongside `bookingId` and `sessionId`. The opaque bearer token itself is never logged.

After the grant is consumed, the gateway browser session stores `accessRequestId`. A later HTTP relay or WebSocket upgrade can therefore be correlated to the original renter access request even though it is a different network request.

For WebSocket traffic, `workspace-gateway.ts` creates a child logger containing the durable business identifiers plus `channelId` and `openRequestId`. Critical lifecycle and error logs inside that channel use the child logger.

## Secret and payload hygiene

Never place any of the following in the correlation context or ordinary logs:

- workspace access grant token;
- renter session cookie or gateway cookie;
- `Authorization` header;
- agent signature or private/public signing material beyond already-approved machine identifiers;
- raw WebSocket frames, `dataBase64`, HTTP request bodies or artifact bytes;
- Supabase access tokens, Redis URLs, database URLs or S3 credentials.

The Fastify logger already redacts sensitive request headers. Correlation changes must not weaken those redactions.

## Operator workflow for “Ouvrir mon espace” incidents

1. Start from the `x-request-id` returned to PC B for the access call. Search it as `requestId`; downstream gateway logs will expose the same value as `accessRequestId`.
2. Read `bookingId`, `workspaceSessionId`, `machineId` and `jobId` from the correlated gateway context.
3. Follow `channelId` through browser connect, upstream open, relay/backpressure errors and browser close.
4. Follow `openRequestId` when checking the agent `ws_open` request/ack path.
5. Compare gateway liveness and machine heartbeat timestamps before deciding the fault belongs to PC A, the gateway, Redis or the workspace container.

A normal successful sequence should contain, for the same correlation context:

`workspace_gateway_browser_connected -> workspace_gateway_upstream_opened -> upstream frames -> workspace_gateway_browser_closed`.

If `workspace_gateway_upstream_open_failed` appears, `openRequestId`, `machineId`, `workspaceSessionId` and `accessRequestId` are the primary keys for the incident timeline.

## Logging design rule

Prefer one child logger/context per lifecycle object over repeating hand-built partial objects on every message. When a new gateway lifecycle event is added inside the channel, it should use the correlated child logger unless it intentionally occurs before the durable session/machine context is known.

## Validation

CI must verify that:

- renter routes pass `request.id` into access grants;
- access grants round-trip the request id while staying opaque and one-time;
- gateway sessions retain the access request id;
- critical WebSocket logs use the complete correlation child logger;
- the child logger contains identifiers only and no bearer token, cookie, signature or payload fields.
