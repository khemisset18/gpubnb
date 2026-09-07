# GPUbnb web public origins

Last audited: 2026-09-07.

The browser must not contain a hosting-provider fallback for the API or Developer Workspace gateway. Public origins are deployment inputs, not source-code constants.

## Build inputs

Hosted web builds use:

- `GPUBNB_API_ORIGIN` — required HTTPS origin for the public Fastify API.
- `GPUBNB_GATEWAY_ORIGIN` — optional HTTPS origin for the workspace HTTP/WebSocket gateway. If omitted, the API origin is used, which is valid only when both share the same public origin.
- `GPUBNB_PREVIEW_API_ORIGIN` — optional deploy-preview API override.
- `GPUBNB_PREVIEW_GATEWAY_ORIGIN` — optional deploy-preview gateway override.

Production, deploy-preview and branch-deploy builds fail closed when the API origin is absent, malformed, contains credentials/query/path fragments, or is not HTTPS.

Local development does not require those variables and falls back to `http://localhost:3000`.

## Generated published configuration

`scripts/generate-web-build-info.mjs` produces three deployment artifacts inside `apps/web`:

1. `config.js` keeps browser API calls on same-origin `/api` and injects the configured workspace gateway origin.
2. `_redirects` proxies `/api/*` to the configured API origin with a 200 rewrite.
3. `_headers` emits the CSP, including only the configured gateway HTTP/WebSocket origin plus the explicitly required Solana/Supabase/CDN origins.

These generated files let the same source tree deploy to any compatible provider without editing application code.

## Security rules

- Never put database, Redis, Supabase service-role or S3 credentials into these variables; they are public build configuration.
- Never add an automatic provider-specific fallback when a hosted origin is missing.
- Do not accept origin values with embedded credentials, query strings, fragments or non-root paths.
- Hosted origins are HTTPS; the generated WebSocket CSP origin is therefore `wss:`.
- The browser continues to call `/api`, preserving same-origin cookies and avoiding a direct cross-origin API dependency.
- The workspace gateway origin is separate because Developer Workspace WebSocket traffic may require a direct WebSocket-capable public runtime.

## Netlify deployment

Set the variables in the Netlify build environment for the production context. Deploy previews can use the preview-specific variables when a separate preview backend exists; otherwise they reuse the normal configured origins.

The root `netlify.toml` deliberately does not contain an API vendor hostname or static gateway CSP entry. The build-generated `_redirects` and `_headers` are the public routing/security source of truth.

## Verification before production cutover

For the configured production origins verify all of the following from the deployed site:

- `/api/health` or the appropriate proxied readiness endpoint reaches the intended API runtime;
- authentication cookies work through `/api`;
- the Developer Workspace status reaches `canOpen=true` only with fresh gateway liveness;
- `Ouvrir mon espace` resolves the server-provided `openPath` against the configured gateway origin;
- the workspace WebSocket opens successfully under the generated CSP;
- no browser request is sent to a historical provider hostname.

Repository CI uses reserved `.invalid` origins to test this build contract without pretending they are live production addresses.
