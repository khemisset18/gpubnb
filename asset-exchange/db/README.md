# Asset Exchange persistence boundary

Status: G5 FOUNDATION / NOT DEPLOYED / NO REAL FUNDS

## Isolation

This schema MUST run in a dedicated Asset Exchange PostgreSQL database.

Forbidden:
- GPUbnb Core DATABASE_URL;
- Core database roles;
- Core migrations;
- cross-database foreign keys to Core;
- Core session tables.

Recommended environment variable name for the future service:
`ASSET_EXCHANGE_DATABASE_URL`.

Do not alias it to `DATABASE_URL` in shared deployment configuration.

## Financial representation

Atomic asset amounts use exact PostgreSQL `numeric(39,0)` with an explicit u128 upper bound.

Never use:
- real;
- float;
- double precision;
- money.

## Whole-fill / double-fill protection

V1 is whole-fill only.

The database enforces:
- one row per `offer_id`;
- one `trade` per offer via `trades.offer_id UNIQUE`;
- one `accepted_trade_id` per offer;
- consumed offer must reference a trade;
- open/cancelled/expired offer cannot reference an accepted trade.

Application acceptance MUST execute in one PostgreSQL transaction.

Required pattern:

1. validate authenticated taker and signed acceptance outside/inside transaction as appropriate;
2. `SELECT ... FOR UPDATE` the offer row;
3. verify `state = OPEN`, authoritative expiry, exact `offer_hash`, expected `policy_epoch`, active policy;
4. insert the trade;
5. set offer to `CONSUMED` and bind `accepted_trade_id`;
6. append first durable trade event;
7. commit.

If any step fails, rollback all steps.

Never implement acceptance as an unlocked SELECT followed later by UPDATE.

## Idempotency

Every externally retried financial command needs:
- authenticated scope;
- idempotency key;
- canonical request hash.

A repeated key with the same request hash may return the original result.
A repeated key with a different request hash MUST fail.

Idempotency does not replace database state preconditions.

## Fee policies

Fee policy rows are immutable.

Changing owner/operator commission means:
- insert a new policy version;
- activate it for new trades through operator configuration;
- old trades remain pinned to old policy/version.

The database trigger rejects UPDATE/DELETE of fee policy rows.

## Operator transition

`TRANSITION` requires all new marketplace/lock switches false.

Recovery/redeem/refund switches are intentionally not represented as disable-able fields here.
The operator-state table therefore cannot accidentally switch recovery off.

## Events

`trade_events` is append-oriented financial orchestration evidence.

Future application role permissions should:
- INSERT events;
- SELECT events;
- forbid UPDATE/DELETE of historical events.

A later migration should enforce append-only privileges/triggers after deployment roles are defined.

## Pending before deployment

- dedicated database/user provisioning;
- TLS and certificate verification;
- least-privilege roles;
- backups + PITR;
- migration CI against pinned PostgreSQL image;
- concurrency tests with two real DB sessions;
- crash-after-commit / retry tests;
- RLS decision (service authz remains mandatory either way).

This migration is not authorized for production yet.
