# GPUbnb Developer Workspace — Production Qualification Standard

This document defines the release bar for the Developer Workspace path. A green unit-test run is not sufficient. A build is considered qualified only when every gate below is satisfied on the exact commit and, where applicable, on the exact published artifact.

## 1. Critical path

Browser -> public HTTPS/WSS -> GPUbnb API -> Redis transport -> Host Agent -> local TCP proxy -> code-server -> return path to browser.

The qualification must prove both VS Code channels required by the workbench (Management and ExtensionHost), not merely successful HTML delivery or one `101 Switching Protocols` response.

## 2. Mandatory release gates

1. API tests, production gates, strict TypeScript, Agent tests, dependency audit and security scans: all green.
2. Developer Workspace image smoke: real browser, workbench visible, critical JS/WASM/CSS MIME/status checks, Management and ExtensionHost established.
3. Workspace transport soak: 25 consecutive clean Agent workspace-suite passes with no flakes.
4. Workspace API contract soak: 10 consecutive clean gateway-contract passes against real PostgreSQL + Redis services.
5. Windows preflight: exact sidecar bundled; silent install; Agent executable; runtime-check; automatic Windows service; service restart; clean uninstall.
6. Release pre-upload verification: the exact staged Windows installer must pass the same install/service/uninstall smoke before upload.
7. Release post-download verification: a separate fresh Windows runner must download the immutable GitHub Release asset, verify SHA-256, install it, exercise Agent/service, and uninstall it.
8. Physical two-machine validation: Host PC and renter PC must complete a fresh rental with a visible, interactive workbench. Evidence must include the release tag/SHA, Agent version, session id, Management success, ExtensionHost success, and absence of workspace transport errors.

No physical validation may be recorded as PASSED from local Docker/Chrome simulation alone.

## 3. Failure policy

- Any intermittent failure is a failure. Re-running until green is not a qualification strategy.
- Transient external packaging downloads may use bounded retry, but functional tests may not be hidden by retry.
- A failed immutable release remains available for diagnosis, but mutable aliases must not continue to advertise a release that failed post-publication verification.
- No release promotion after a failed workspace gate without a new commit or an explicitly proven external-infrastructure-only retry.

## 4. Transport invariants

- Preserve WebSocket bytes and opcodes end-to-end.
- Never decode binary payloads as UTF-8.
- Strict Base64 validation at trust boundaries.
- Bounded queues by both item count and bytes.
- Explicit backpressure instead of unbounded buffering.
- Idempotent frame retries must reuse frame ids.
- `close` must be serialized behind preceding frames.
- Queue TTL must remain bounded and refreshed only through valid activity.
- Browser-facing rejection and upstream failure must be explicit and observable.
- No session activation race may permit double activation or frames before activation.

## 5. Observability requirements

For each workspace connection, structured logs must make it possible to determine, without payload contents:

- session/channel identifier;
- browser upgrade received/authenticated;
- Agent open command sent/acknowledged;
- local code-server socket connected;
- first browser frame;
- first local frame;
- first upstream batch delivered;
- close code/reason class;
- backpressure/retry counters;
- API route and status for transport failures.

Secrets, cookies, frame payloads and tokens must never be logged.

## 6. Physical acceptance criteria

A physical test is PASS only if all of the following are true on one fresh rental:

- exact published Windows release is installed on the Host;
- Agent/service report healthy;
- workspace opens without manual browser-console intervention;
- Management establishes;
- ExtensionHost establishes;
- workbench is visibly interactive (editor + terminal or equivalent remote action);
- no `UnicodeDecodeError`, transport 5xx loop, uncontrolled 429 loop, queue overflow, or unexpected socket close occurs;
- clean rental teardown leaves no orphan workspace container/channel.

If any item fails, the release remains unqualified and the failure must be converted into a deterministic regression test before the next promotion attempt.

## 7. Next-level reliability work

The current HTTP/Redis relay is deliberately guarded with batching, idempotency and backpressure. Long-term architecture should reduce the number of transport layers by moving toward a persistent bidirectional Agent tunnel with explicit flow control, channel multiplexing, heartbeat/liveness and reconnect/resume semantics. That migration must be benchmarked against the current implementation and introduced behind a capability/version gate rather than replacing the live path in one step.
